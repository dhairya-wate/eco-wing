const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
  'Drone-Alpha': 'drone_alpha_token_12345678901234567890',
  'Drone-Beta': 'drone_beta_token_12345678901234567890'
});

const rootDir = path.resolve(__dirname, '../../..');

const { CommandManager } = require('../../src/services/commandManager');
test('Drone Safety Command Manager & State Machine (E9)', async (t) => {
  const cm = new CommandManager();

  await t.test('creates command in initial state requested with UUIDv4', () => {
    const cmd = cm.createCommand({ drone_id: 'Drone-Alpha', command: 'land' });
    assert.equal(cmd.state, 'requested');
    assert.match(cmd.command_id, /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
    assert.equal(cmd.state_history.length, 1);
    assert.equal(cmd.state_history[0].state, 'requested');
  });

  await t.test('rejects invalid command verb', () => {
    assert.throws(() => {
      cm.createCommand({ drone_id: 'Drone-Alpha', command: 'explode' });
    }, /Invalid command verb/);
  });

  await t.test('follows valid state machine lifecycle: requested -> sent -> acknowledged -> executing -> completed', () => {
    const cmd = cm.createCommand({ drone_id: 'Drone-Alpha', command: 'start' });
    const id = cmd.command_id;

    const r1 = cm.transitionCommand(id, 'sent', 'sent to socket');
    assert.equal(r1.ok, true);
    assert.equal(r1.command.state, 'sent');

    const r2 = cm.transitionCommand(id, 'acknowledged', 'ack received');
    assert.equal(r2.ok, true);
    assert.equal(r2.command.state, 'acknowledged');

    const r3 = cm.transitionCommand(id, 'executing', 'takeoff initiated');
    assert.equal(r3.ok, true);
    assert.equal(r3.command.state, 'executing');

    const r4 = cm.transitionCommand(id, 'completed', 'in flight');
    assert.equal(r4.ok, true);
    assert.equal(r4.command.state, 'completed');
    assert.equal(r4.command.state_history.length, 5);
  });

  await t.test('rejects illegal state transition directly from requested to completed', () => {
    const cmd = cm.createCommand({ drone_id: 'Drone-Alpha', command: 'rth' });
    const res = cm.transitionCommand(cmd.command_id, 'completed');
    assert.equal(res.ok, false);
    assert.match(res.error, /Illegal state transition/);
  });

  await t.test('rejects transition from terminal completed state', () => {
    const cmd = cm.createCommand({ drone_id: 'Drone-Alpha', command: 'land' });
    cm.transitionCommand(cmd.command_id, 'sent');
    cm.transitionCommand(cmd.command_id, 'acknowledged');
    cm.transitionCommand(cmd.command_id, 'executing');
    cm.transitionCommand(cmd.command_id, 'completed');

    const res = cm.transitionCommand(cmd.command_id, 'executing');
    assert.equal(res.ok, false);
    assert.match(res.error, /Illegal state transition/);
  });

  await t.test('detects stale telemetry past 10 seconds threshold', () => {
    const pastTime = Date.now() - 15000; // 15s ago
    cm.recordTelemetry('Drone-Stale', pastTime);

    const freshness = cm.checkTelemetryFreshness('Drone-Stale', 10.0);
    assert.equal(freshness.fresh, false);
    assert.ok(freshness.age_seconds >= 14.9);
    assert.match(freshness.error, /Stale telemetry/);

    // After updating with fresh telemetry
    cm.recordTelemetry('Drone-Stale', Date.now());
    const freshNow = cm.checkTelemetryFreshness('Drone-Stale', 10.0);
    assert.equal(freshNow.fresh, true);
  });

  await t.test('arms ACK timeout transitioning sent command to timed_out', async () => {
    const cmd = cm.createCommand({ drone_id: 'Drone-Alpha', command: 'hold' });
    cm.transitionCommand(cmd.command_id, 'sent');

    let timeoutFired = false;
    cm.armAckTimeout(cmd.command_id, 0.05, (timedOutCmd) => {
      timeoutFired = true;
    });

    await new Promise(resolve => setTimeout(resolve, 80));

    assert.equal(timeoutFired, true);
    const updated = cm.getCommand(cmd.command_id);
    assert.equal(updated.state, 'timed_out');
    assert.match(updated.error_message, /ACK timeout/);
  });
});

