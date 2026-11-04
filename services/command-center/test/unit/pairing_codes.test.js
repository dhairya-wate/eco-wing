const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';

const { deviceStore } = require('../../src/services/deviceStore');
const PairingCode = require('../../src/models/PairingCode');
const Session = require('../../src/models/Session');
const { commandManager } = require('../../src/services/commandManager');

test('Three-Tier Token Model: Pairing Codes (Tier 2) & Scoped Sessions (Tier 3)', async (t) => {
  deviceStore.clear();

  // Seed active test phone
  await deviceStore.registerDevice({
    device_id: 'phone-field-01',
    name: 'Field Phone 1',
    type: 'phone'
  });

  await t.test('creates 6-character pairing code conforming to unambiguous alphabet', async () => {
    const pairing = await deviceStore.createPairingCode('phone-field-01', 300);
    assert.equal(pairing.device_id, 'phone-field-01');
    assert.equal(pairing.code.length, 6);
    assert.equal(pairing.expires_in, 300);

    for (const char of pairing.code) {
      assert.ok(
        PairingCode.UNAMBIGUOUS_ALPHABET.includes(char),
        `Character '${char}' must belong to unambiguous alphabet`
      );
    }
  });

  await t.test('single-use exchange burns code and issues opaque session token', async () => {
    const pairing = await deviceStore.createPairingCode('phone-field-01', 300);
    const exchange = await deviceStore.verifyAndBurnPairingCode(pairing.code);

    assert.equal(exchange.valid, true);
    assert.equal(exchange.device_id, 'phone-field-01');
    assert.ok(exchange.session_id.startsWith('sess_'));
    assert.ok(exchange.session_token.startsWith('ecowing_sess_'));
    assert.ok(exchange.expires_at);

    // Verify session token is verifiable in store
    const isSessValid = await deviceStore.verifySessionToken(exchange.session_id, exchange.session_token);
    assert.equal(isSessValid, true);

    // Second exchange attempt must fail (single-use burned)
    const replay = await deviceStore.verifyAndBurnPairingCode(pairing.code);
    assert.equal(replay.valid, false);
    assert.match(replay.error, /already been used/);
  });

  await t.test('burns code permanently after 5 failed exchange attempts', async () => {
    const pairing = await deviceStore.createPairingCode('phone-field-01', 300);

    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      await deviceStore.recordFailedCodeAttempt(pairing.code);
    }
    const memEntry = deviceStore.memoryPairingCodes.get(pairing.code);
    assert.equal(memEntry.attempts, 4);
    assert.equal(memEntry.used, false);

    // 5th failed attempt burns the code
    await deviceStore.recordFailedCodeAttempt(pairing.code);
    assert.equal(memEntry.attempts, 5);
    assert.equal(memEntry.used, true);

    // Exchange attempt now reports burned
    const exchange = await deviceStore.verifyAndBurnPairingCode(pairing.code);
    assert.equal(exchange.valid, false);
    assert.match(exchange.error, /burned due to excessive failed attempts|already been used/);
  });

  await t.test('immediate session revocation invalidates session token', async () => {
    const pairing = await deviceStore.createPairingCode('phone-field-01', 300);
    const exchange = await deviceStore.verifyAndBurnPairingCode(pairing.code);

    assert.equal(exchange.valid, true);
    const verifyBefore = await deviceStore.verifySessionToken(exchange.session_id, exchange.session_token);
    assert.equal(verifyBefore, true);

    // Revoke session
    const rev = await deviceStore.revokeSession(exchange.session_id);
    assert.equal(rev.status, 'revoked');

    const verifyAfter = await deviceStore.verifySessionToken(exchange.session_id, exchange.session_token);
    assert.equal(verifyAfter, false);
  });

  await t.test('cross-target command validation: enforces target separation', () => {
    // Drone command on drone target succeeds
    const droneCmd = commandManager.createCommand({
      drone_id: 'drone-01',
      target: 'drone',
      command: 'hold'
    });
    assert.equal(droneCmd.target, 'drone');
    assert.equal(droneCmd.command, 'hold');

    // Phone command on phone target succeeds
    const phoneCmd = commandManager.createCommand({
      drone_id: 'phone-01',
      target: 'phone',
      command: 'set_confidence',
      params: { confidence: 0.75 }
    });
    assert.equal(phoneCmd.target, 'phone');
    assert.equal(phoneCmd.command, 'set_confidence');
    assert.equal(phoneCmd.params.confidence, 0.75);

    // Reject phone command sent to drone
    assert.throws(() => {
      commandManager.createCommand({
        drone_id: 'drone-01',
        target: 'drone',
        command: 'pause_stream'
      });
    }, /Invalid command verb 'pause_stream' for target 'drone'/);

    // Reject drone command sent to phone
    assert.throws(() => {
      commandManager.createCommand({
        drone_id: 'phone-01',
        target: 'phone',
        command: 'start'
      });
    }, /Invalid command verb 'start' for target 'phone'/);

    // Reject set_confidence with invalid range
    assert.throws(() => {
      commandManager.createCommand({
        drone_id: 'phone-01',
        target: 'phone',
        command: 'set_confidence',
        params: { confidence: 1.5 }
      });
    }, /must be a number between 0.0 and 1.0/);

    assert.throws(() => {
      commandManager.createCommand({
        drone_id: 'phone-01',
        target: 'phone',
        command: 'set_confidence',
        params: { confidence: -0.1 }
      });
    }, /must be a number between 0.0 and 1.0/);
  });

  await t.test('mobile URL and QR configuration: dynamically uses ECOWING_PUBLIC_URL with no hardcoded hosts', async () => {
    const express = require('express');
    const http = require('http');
    const { router: apiRouter } = require('../../src/routes/api');

    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. When ECOWING_PUBLIC_URL is configured
      process.env.ECOWING_PUBLIC_URL = 'https://ecowing.example.org';
      const confRes = await fetch(`${baseUrl}/api/mobile/config`);
      assert.equal(confRes.status, 200);
      const confData = await confRes.json();
      assert.equal(confData.ecowing_public_url, 'https://ecowing.example.org');
      assert.equal(confData.mobile_path, '/mobile');

      const pairRes = await fetch(`${baseUrl}/api/mobile/pairing_code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Operator-Token': process.env.ECOWING_OPERATOR_TOKEN
        },
        body: JSON.stringify({ device_id: 'phone-field-01' })
      });
      assert.equal(pairRes.status, 200);
      const pairData = await pairRes.json();
      assert.ok(pairData.code);
      assert.equal(pairData.mobile_url, `https://ecowing.example.org/mobile?code=${pairData.code}`);
      assert.equal(pairData.mobile_url.includes('detection-system-flax.vercel.app'), false);

      // 2. When ECOWING_PUBLIC_URL is unset
      delete process.env.ECOWING_PUBLIC_URL;
      const unsetConfRes = await fetch(`${baseUrl}/api/mobile/config`);
      const unsetConfData = await unsetConfRes.json();
      assert.equal(unsetConfData.ecowing_public_url, null);

      const unsetPairRes = await fetch(`${baseUrl}/api/mobile/pairing_code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Operator-Token': process.env.ECOWING_OPERATOR_TOKEN
        },
        body: JSON.stringify({ device_id: 'phone-field-01' })
      });
      const unsetPairData = await unsetPairRes.json();
      assert.equal(unsetPairData.mobile_url, null, 'mobile_url must be null when ECOWING_PUBLIC_URL is unset');

      // 3. Unified POST /api/drone/command with target: 'phone'
      const phoneCmdRes = await fetch(`${baseUrl}/api/drone/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Operator-Token': process.env.ECOWING_OPERATOR_TOKEN
        },
        body: JSON.stringify({
          drone_id: 'phone-field-01',
          target: 'phone',
          command: 'set_confidence',
          params: { confidence: 0.85 }
        })
      });
      assert.equal(phoneCmdRes.status, 200);
      const phoneCmdData = await phoneCmdRes.json();
      assert.equal(phoneCmdData.success, true);
      assert.equal(phoneCmdData.command.command, 'set_confidence');
      assert.equal(phoneCmdData.command.params.confidence, 0.85);

      // 4. Unified POST /api/drone/command: reject drone flight command sent to phone
      const badPhoneCmdRes = await fetch(`${baseUrl}/api/drone/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Operator-Token': process.env.ECOWING_OPERATOR_TOKEN
        },
        body: JSON.stringify({
          drone_id: 'phone-field-01',
          target: 'phone',
          command: 'start'
        })
      });
      assert.equal(badPhoneCmdRes.status, 400);

      // 5. Unified POST /api/drone/command: reject phone command sent to drone
      const badDroneCmdRes = await fetch(`${baseUrl}/api/drone/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Operator-Token': process.env.ECOWING_OPERATOR_TOKEN
        },
        body: JSON.stringify({
          drone_id: 'drone-01',
          target: 'drone',
          command: 'pause_stream'
        })
      });
      assert.equal(badDroneCmdRes.status, 400);

    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
