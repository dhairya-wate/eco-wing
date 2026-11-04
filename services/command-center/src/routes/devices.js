/**
 * Device, Mobile Pairing, and Session Management Routes
 * Implements Three-Tier Token Architecture & Command Dispatching
 */

const express = require('express');
const router = express.Router();
const { deviceStore } = require('../services/deviceStore');
const { verifyOperatorToken, verifyServiceToken } = require('../middleware/auth');
const { commandManager } = require('../services/commandManager');

/**
 * GET /api/devices
 * List all registered devices (omits token_hash)
 * Protected: Operator only
 */
router.get('/devices', verifyOperatorToken, async (req, res) => {
  try {
    const devices = await deviceStore.listDevices();
    res.json({ success: true, count: devices.length, devices });
  } catch (err) {
    console.error('Error in GET /api/devices:', err);
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

/**
 * POST /api/devices
 * Register a new phone or drone device
 * Returns raw device token ONCE; stores only SHA-256 hash.
 * Protected: Operator only
 */
router.post('/devices', verifyOperatorToken, async (req, res) => {
  try {
    const { device_id, name, type, metadata } = req.body;
    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: "Missing or invalid 'device_id'." });
    }
    const cleanType = String(type || 'phone').trim().toLowerCase();
    if (!['phone', 'drone'].includes(cleanType)) {
      return res.status(400).json({ error: "Invalid 'type'. Must be 'phone' or 'drone'." });
    }

    const device = await deviceStore.registerDevice({
      device_id,
      name,
      type: cleanType,
      metadata
    });

    res.status(201).json({
      success: true,
      message: `Device '${device.device_id}' registered successfully. Keep your raw device token safe; it will not be shown again.`,
      device: {
        device_id: device.device_id,
        name: device.name,
        type: device.type,
        status: device.status,
        created_at: device.created_at
      },
      raw_token: device.raw_token
    });
  } catch (err) {
    console.error('Error in POST /api/devices:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/devices/:id/rotate-token
 * Rotates device token and revokes associated active sessions.
 * Protected: Operator only
 */
router.post('/devices/:id/rotate-token', verifyOperatorToken, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const result = await deviceStore.rotateDeviceToken(deviceId);

    // Notify connected clients via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('device_token_rotated', { device_id: deviceId });
    }

    res.json({
      success: true,
      message: `Device token for '${deviceId}' rotated successfully.`,
      device_id: deviceId,
      raw_token: result.raw_token,
      updated_at: result.updated_at
    });
  } catch (err) {
    console.error('Error in POST /api/devices/:id/rotate-token:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/devices/:id/revoke
 * Revokes a device and its active sessions.
 * Protected: Operator only
 */
router.post('/devices/:id/revoke', verifyOperatorToken, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const result = await deviceStore.revokeDevice(deviceId);

    const io = req.app.get('io');
    if (io) {
      io.emit('device_revoked', { device_id: deviceId });
    }

    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/devices/:id/revoke:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/mobile/pairing_code
 * Generates single-use 6-character pairing code with 5-minute TTL.
 * Protected: Operator only
 */
router.post('/mobile/pairing_code', verifyOperatorToken, async (req, res) => {
  try {
    let deviceId = req.body.device_id;

    // If no device_id supplied, look up or auto-register a default phone sensor
    if (!deviceId) {
      const devices = await deviceStore.listDevices();
      const phone = devices.find(d => d.type === 'phone' && d.status === 'active');
      if (phone) {
        deviceId = phone.device_id;
      } else {
        const autoReg = await deviceStore.registerDevice({
          device_id: 'phone-' + Math.floor(1000 + Math.random() * 9000),
          name: 'Mobile Broadcaster',
          type: 'phone'
        });
        deviceId = autoReg.device_id;
      }
    }

    const ttlSeconds = Number(req.body.ttl_seconds) || 300;
    const pairing = await deviceStore.createPairingCode(deviceId, ttlSeconds);

    const io = req.app.get('io');
    if (io) {
      io.emit('pairing_code_generated', {
        code: pairing.code,
        device_id: pairing.device_id,
        expires_at: pairing.expires_at
      });
    }

    res.json({
      success: true,
      code: pairing.code,
      device_id: pairing.device_id,
      expires_in: pairing.expires_in,
      expires_at: pairing.expires_at
    });
  } catch (err) {
    console.error('Error in POST /api/mobile/pairing_code:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/mobile/verify_code
 * Exchanges pairing code for a scoped session token.
 * Single-use: burns the code on success. Rate-limited: burns on 5 failures.
 * Protected: Internal Detection Service or Operator
 */
router.post('/mobile/verify_code', verifyServiceToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: "Missing or invalid 'code'." });
    }

    const result = await deviceStore.verifyAndBurnPairingCode(code);
    if (!result.valid) {
      await deviceStore.recordFailedCodeAttempt(code);
      return res.status(401).json({
        success: false,
        error: result.error || "Invalid, expired, or already used pairing code."
      });
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('session_created', {
        session_id: result.session_id,
        device_id: result.device_id,
        expires_at: result.expires_at
      });
    }

    res.json({
      success: true,
      session_id: result.session_id,
      session_token: result.session_token,
      device_id: result.device_id,
      expires_at: result.expires_at,
      scope: ['stream', 'command']
    });
  } catch (err) {
    console.error('Error in POST /api/mobile/verify_code:', err);
    res.status(500).json({ error: 'Failed to verify pairing code' });
  }
});

/**
 * GET /api/mobile/sessions
 * List active phone sessions
 * Protected: Operator only
 */
router.get('/mobile/sessions', verifyOperatorToken, async (req, res) => {
  try {
    const sessions = await deviceStore.listActiveSessions();
    res.json({ success: true, count: sessions.length, sessions });
  } catch (err) {
    console.error('Error in GET /api/mobile/sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * POST /api/mobile/revoke-session
 * Revoke an active phone session immediately.
 * Protected: Operator or Service
 */
router.post('/mobile/revoke-session', async (req, res, next) => {
  // Allow operator or service token
  const opToken = req.headers['x-operator-token'];
  const srvToken = req.headers['x-service-token'] || req.headers['authorization'];
  if (opToken) {
    return verifyOperatorToken(req, res, () => handleRevokeSession(req, res));
  }
  if (srvToken) {
    return verifyServiceToken(req, res, () => handleRevokeSession(req, res));
  }
  return res.status(401).json({ error: "Unauthorized: provide 'X-Operator-Token' or 'X-Service-Token' header." });
});

async function handleRevokeSession(req, res) {
  try {
    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: "Missing required 'session_id'." });
    }

    const result = await deviceStore.revokeSession(session_id);

    const io = req.app.get('io');
    if (io) {
      io.emit('session_revoked', { session_id });
      io.to(`session:${session_id}`).emit('session_revoked', { session_id });
    }

    res.json({
      success: true,
      message: `Session '${session_id}' revoked successfully.`,
      session_id
    });
  } catch (err) {
    console.error('Error in POST /api/mobile/revoke-session:', err);
    res.status(400).json({ error: err.message });
  }
}

/**
 * POST /api/device/command
 * Send commands to a phone or drone using the canonical command schema
 * Verbs:
 *   - Drone: start, hold, rth, land, estop, photo, zoom
 *   - Phone: pause_stream, resume_stream, set_confidence (params: { confidence: [0.0, 1.0] })
 * Protected: Operator only
 */
router.post('/device/command', verifyOperatorToken, async (req, res) => {
  try {
    const { drone_id, target = 'drone', command, params, ack_timeout_seconds } = req.body;
    if (!drone_id) {
      return res.status(400).json({ error: "Missing required 'drone_id' or 'device_id'." });
    }
    if (!command) {
      return res.status(400).json({ error: "Missing required 'command'." });
    }

    const cleanTarget = String(target).trim().toLowerCase();

    // Check telemetry freshness for drone flight commands
    if (cleanTarget === 'drone') {
      const freshness = commandManager.checkTelemetryFreshness(drone_id, 10.0);
      if (!freshness.fresh && !freshness.missing) {
        return res.status(409).json({ error: freshness.error, age_seconds: freshness.age_seconds });
      }
    }

    let cmd;
    try {
      cmd = commandManager.createCommand({
        drone_id,
        target: cleanTarget,
        command,
        params,
        actor: req.body.actor || 'operator_console'
      });
    } catch (cmdErr) {
      return res.status(400).json({ error: cmdErr.message });
    }

    // Transition state: requested -> sent
    commandManager.transitionCommand(cmd.command_id, 'sent', `Dispatched to ${cleanTarget} channel`);

    // Arm ACK timeout
    const ackTimeout = Number(ack_timeout_seconds) || 5.0;
    commandManager.armAckTimeout(cmd.command_id, ackTimeout, (timedOutCmd) => {
      const io = req.app.get('io');
      if (io) {
        io.emit('command_timed_out', {
          command_id: timedOutCmd.command_id,
          drone_id,
          target: cleanTarget,
          reason: timedOutCmd.error_message
        });
      }
    });

    const io = req.app.get('io');
    if (io) {
      if (cleanTarget === 'drone') {
        io.emit('drone_command_executed', { command: cmd.command, drone_id, command_id: cmd.command_id });
        io.to(`drone:${drone_id}`).emit('command', { command: cmd.command, command_id: cmd.command_id });
      } else if (cleanTarget === 'phone') {
        io.emit('phone_command_dispatched', { command: cmd.command, device_id: drone_id, params: cmd.params, command_id: cmd.command_id });
        io.to(`phone:${drone_id}`).emit('phone_command', { command: cmd.command, params: cmd.params, command_id: cmd.command_id });
      }
    }

    res.json({
      success: true,
      message: `${cleanTarget.toUpperCase()} command dispatched: ${cmd.command}`,
      command_id: cmd.command_id,
      state: cmd.state,
      command: cmd
    });
  } catch (err) {
    console.error('Error in POST /api/device/command:', err);
    res.status(500).json({ error: 'Failed to dispatch command' });
  }
});

module.exports = router;
