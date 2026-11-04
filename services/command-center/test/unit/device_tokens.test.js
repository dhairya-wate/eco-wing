const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
  'Drone-Alpha': 'drone_alpha_token_12345678901234567890',
  'Drone-Beta': 'drone_beta_token_12345678901234567890'
});

const { deviceStore, constantTimeHashCompare } = require('../../src/services/deviceStore');
const Device = require('../../src/models/Device');
const { verifyDroneToken, migrateDroneTokens } = require('../../src/middleware/auth');

test('Three-Tier Token Model: Device Tokens & Governance (Tier 1)', async (t) => {
  deviceStore.clear();

  await t.test('registers new phone and drone devices with raw token returned once', async () => {
    const phone = await deviceStore.registerDevice({
      device_id: 'phone-recon-01',
      name: 'Pixel 8 Recon',
      type: 'phone'
    });

    assert.equal(phone.device_id, 'phone-recon-01');
    assert.equal(phone.type, 'phone');
    assert.equal(phone.status, 'active');
    assert.ok(phone.raw_token.startsWith('ecowing_phone_'));

    // Check that stored device in store has token_hash matching SHA-256 of raw_token
    const memDev = deviceStore.memoryDevices.get('phone-recon-01');
    assert.ok(memDev.token_hash);
    assert.equal(memDev.token_hash, Device.hashToken(phone.raw_token));
    // Raw token is NOT stored in the device record
    assert.equal(memDev.raw_token, undefined);
  });

  await t.test('rejects registration with duplicate device_id', async () => {
    await assert.rejects(async () => {
      await deviceStore.registerDevice({
        device_id: 'phone-recon-01',
        type: 'phone'
      });
    }, /already registered/);
  });

  await t.test('verifies valid device token using constant-time comparison', async () => {
    const drone = await deviceStore.registerDevice({
      device_id: 'drone-gamma',
      type: 'drone'
    });

    const isValid = await deviceStore.verifyDeviceToken('drone-gamma', drone.raw_token);
    assert.equal(isValid, true);

    const isInvalid = await deviceStore.verifyDeviceToken('drone-gamma', 'wrong_token_value_abc');
    assert.equal(isInvalid, false);

    const isWrongDrone = await deviceStore.verifyDeviceToken('phone-recon-01', drone.raw_token);
    assert.equal(isWrongDrone, false);
  });

  await t.test('rotates device token and returns new raw token once', async () => {
    const dev = await deviceStore.registerDevice({
      device_id: 'phone-rot-01',
      type: 'phone'
    });
    const oldRawToken = dev.raw_token;

    const rotation = await deviceStore.rotateDeviceToken('phone-rot-01');
    assert.ok(rotation.raw_token);
    assert.notEqual(rotation.raw_token, oldRawToken);

    // Old token should now be invalid
    const isOldValid = await deviceStore.verifyDeviceToken('phone-rot-01', oldRawToken);
    assert.equal(isOldValid, false);

    // New token should be valid
    const isNewValid = await deviceStore.verifyDeviceToken('phone-rot-01', rotation.raw_token);
    assert.equal(isNewValid, true);
  });

  await t.test('revokes device and immediately rejects verification', async () => {
    const dev = await deviceStore.registerDevice({
      device_id: 'phone-rev-01',
      type: 'phone'
    });

    const revokeRes = await deviceStore.revokeDevice('phone-rev-01');
    assert.equal(revokeRes.status, 'revoked');

    const isValid = await deviceStore.verifyDeviceToken('phone-rev-01', dev.raw_token);
    assert.equal(isValid, false);
  });

  await t.test('migrates environment DRONE_DEVICE_TOKENS into DeviceStore', async () => {
    const migrated = await migrateDroneTokens();
    assert.ok(migrated.includes('Drone-Alpha'));
    assert.ok(migrated.includes('Drone-Beta'));

    const alphaDev = deviceStore.memoryDevices.get('Drone-Alpha');
    assert.ok(alphaDev);
    assert.equal(alphaDev.type, 'drone');
    assert.equal(alphaDev.status, 'active');

    // Verify token matches hash
    const isValid = await deviceStore.verifyDeviceToken('Drone-Alpha', 'drone_alpha_token_12345678901234567890');
    assert.equal(isValid, true);
  });

  await t.test('verifyDroneToken middleware accepts DeviceStore tokens seamlessly', () => {
    let nextCalled = false;
    const req = {
      body: { drone_id: 'phone-recon-01' },
      headers: { 'x-drone-token': deviceStore.memoryDevices.get('phone-recon-01') ? null : 'bad' }
    };
    // Re-register clean phone
    deviceStore.memoryDevices.delete('phone-test-mid');
    const rawTok = 'ecowing_phone_mid_test_tok_123456789';
    deviceStore.memoryDevices.set('phone-test-mid', {
      device_id: 'phone-test-mid',
      name: 'Test Phone',
      type: 'phone',
      token_hash: Device.hashToken(rawTok),
      status: 'active'
    });

    const midReq = {
      body: { drone_id: 'phone-test-mid' },
      headers: { 'x-drone-token': rawTok }
    };
    const res = { status() { return this; }, json() { return this; } };

    verifyDroneToken(midReq, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(midReq.authenticatedDroneId, 'phone-test-mid');
  });
});
