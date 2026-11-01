/**
 * Drone Safety Command Manager & Finite State Machine (E9)
 * Conforms to contracts/command.schema.json
 */

const crypto = require('crypto');

const ALLOWED_COMMANDS = new Set(['start', 'hold', 'rth', 'land', 'estop', 'photo', 'zoom']);

const ALLOWED_STATES = new Set([
  'requested', 'sent', 'acknowledged', 'executing',
  'completed', 'rejected', 'failed', 'timed_out'
]);

const ALLOWED_TRANSITIONS = {
  requested: ['sent', 'rejected'],
  sent: ['acknowledged', 'timed_out', 'failed', 'rejected'],
  acknowledged: ['executing', 'failed', 'timed_out'],
  executing: ['completed', 'failed', 'timed_out'],
  completed: [],
  rejected: [],
  failed: [],
  timed_out: []
};

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DRONE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

class CommandManager {
  constructor() {
    this.commands = new Map(); // command_id -> command
    this.activeTimeouts = new Map(); // command_id -> timeoutHandle
    this.latestDroneTelemetryTime = new Map(); // drone_id -> timestamp (ms)
  }

  /**
   * Updates the latest telemetry observation timestamp for a drone.
   */
  recordTelemetry(droneId, timestamp = Date.now()) {
    if (!droneId) return;
    const cleanId = String(droneId).trim();
    const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    this.latestDroneTelemetryTime.set(cleanId, ts);
  }

  /**
   * Checks whether telemetry for a given drone is fresh (<= maxAgeSeconds).
   */
  checkTelemetryFreshness(droneId, maxAgeSeconds = 10.0) {
    if (!droneId) {
      return { fresh: false, error: 'Missing drone_id.' };
    }
    const cleanId = String(droneId).trim();
    const lastTs = this.latestDroneTelemetryTime.get(cleanId);
    if (!lastTs) {
      return {
        fresh: false,
        missing: true,
        age_seconds: Infinity,
        error: `No recent telemetry received for drone '${cleanId}'.`
      };
    }

    const ageMs = Date.now() - lastTs;
    const ageSeconds = ageMs / 1000.0;
    if (ageSeconds > maxAgeSeconds) {
      return {
        fresh: false,
        missing: false,
        age_seconds: Number(ageSeconds.toFixed(2)),
        error: `Stale telemetry: Drone '${cleanId}' telemetry is ${ageSeconds.toFixed(1)}s old (> ${maxAgeSeconds}s threshold).`
      };
    }

    return { fresh: true, age_seconds: Number(ageSeconds.toFixed(2)) };
  }

  /**
   * Creates a new command instance in initial state 'requested'.
   */
  createCommand({ drone_id, command, params = {}, actor = 'operator_console', command_id = null }) {
    if (!drone_id || !DRONE_ID_REGEX.test(String(drone_id))) {
      throw new Error(`Invalid drone_id: '${drone_id}'.`);
    }

    const cleanCommand = String(command).trim().toLowerCase();
    if (!ALLOWED_COMMANDS.has(cleanCommand)) {
      throw new Error(`Invalid command verb: '${cleanCommand}'. Allowed: ${Array.from(ALLOWED_COMMANDS).join(', ')}.`);
    }

    let cmdId = command_id;
    if (cmdId) {
      if (!UUID_REGEX.test(String(cmdId))) {
        throw new Error(`Invalid command_id format: '${cmdId}'. Must be a valid UUIDv4.`);
      }
    } else {
      cmdId = crypto.randomUUID();
    }

    const now = new Date().toISOString();
    const commandObj = {
      command_id: cmdId,
      drone_id: String(drone_id),
      command: cleanCommand,
      params: typeof params === 'object' && params !== null ? params : {},
      state: 'requested',
      actor: String(actor || 'operator_console'),
      created_at: now,
      updated_at: now,
      state_history: [
        {
          state: 'requested',
          timestamp: now,
          reason: 'Command initiated by ' + actor
        }
      ]
    };

    this.commands.set(cmdId, commandObj);
    return commandObj;
  }

  /**
   * Transitions a command through the formal state machine.
   */
  transitionCommand(commandId, targetState, reason = '') {
    const cmd = this.commands.get(commandId);
    if (!cmd) {
      return { ok: false, error: `Command '${commandId}' not found.` };
    }

    if (!ALLOWED_STATES.has(targetState)) {
      return { ok: false, error: `Invalid state '${targetState}'.` };
    }

    const currentState = cmd.state;
    const allowed = ALLOWED_TRANSITIONS[currentState] || [];
    if (!allowed.includes(targetState)) {
      return {
        ok: false,
        error: `Illegal state transition from '${currentState}' to '${targetState}'. Allowed transitions: [${allowed.join(', ')}].`
      };
    }

    const now = new Date().toISOString();
    cmd.state = targetState;
    cmd.updated_at = now;
    if (['rejected', 'failed', 'timed_out'].includes(targetState) && reason) {
      cmd.error_message = reason;
    }

    const historyEntry = { state: targetState, timestamp: now };
    if (reason) historyEntry.reason = reason;
    cmd.state_history.push(historyEntry);

    // If reached terminal state, clear any active ACK timers
    if (['completed', 'rejected', 'failed', 'timed_out'].includes(targetState)) {
      this.clearAckTimeout(commandId);
    }

    return { ok: true, command: cmd };
  }

  /**
   * Arm an ACK timeout guard for a sent command.
   */
  armAckTimeout(commandId, timeoutSeconds = 5.0, onTimeout = null) {
    this.clearAckTimeout(commandId);

    const handle = setTimeout(() => {
      const cmd = this.commands.get(commandId);
      if (cmd && ['requested', 'sent'].includes(cmd.state)) {
        this.transitionCommand(
          commandId,
          'timed_out',
          `ACK timeout: Drone failed to acknowledge command within ${timeoutSeconds}s.`
        );
        if (typeof onTimeout === 'function') {
          onTimeout(cmd);
        }
      }
    }, timeoutSeconds * 1000);

    this.activeTimeouts.set(commandId, handle);
  }

  clearAckTimeout(commandId) {
    if (this.activeTimeouts.has(commandId)) {
      clearTimeout(this.activeTimeouts.get(commandId));
      this.activeTimeouts.delete(commandId);
    }
  }

  getCommand(commandId) {
    return this.commands.get(commandId) || null;
  }

  clear() {
    for (const handle of this.activeTimeouts.values()) {
      clearTimeout(handle);
    }
    this.activeTimeouts.clear();
    this.commands.clear();
    this.latestDroneTelemetryTime.clear();
  }
}

const commandManager = new CommandManager();

module.exports = {
  ALLOWED_COMMANDS,
  ALLOWED_STATES,
  ALLOWED_TRANSITIONS,
  CommandManager,
  commandManager
};
