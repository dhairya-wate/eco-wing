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
const {
  verifyDroneToken,
  migrateDroneTokens,
  setLegacyEnvTokensEnabled,
  getLegacyEnvTokensEnabled
} = require('../../src/middleware/auth');

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

  await t.test('proves drone token migration from DRONE_DEVICE_TOKENS to DeviceStore', async () => {
    // a. Sets DRONE_DEVICE_TOKENS to a known drone ID and token
    const testDroneId = 'Drone-Migration-Proof';
    const testToken = 'drone_mig_secret_token_abcdef1234567890';
    process.env.DRONE_DEVICE_TOKENS = JSON.stringify({ [testDroneId]: testToken });

    // b. Runs migrateDroneTokens()
    const migratedList = await migrateDroneTokens();
    assert.ok(migratedList.includes(testDroneId));

    // c. Confirms a Device record exists with type "drone", the same drone ID, and a token_hash equal to SHA-256 of the original token
    const devRecord = deviceStore.memoryDevices.get(testDroneId);
    assert.ok(devRecord, 'Device record must exist in DeviceStore');
    assert.equal(devRecord.type, 'drone');
    assert.equal(devRecord.device_id, testDroneId);
    const expectedHash = crypto.createHash('sha256').update(testToken).digest('hex');
    assert.equal(devRecord.token_hash, expectedHash);

    // d. Unsets DRONE_DEVICE_TOKENS
    delete process.env.DRONE_DEVICE_TOKENS;
    delete process.env[`DRONE_TOKEN_${testDroneId.toUpperCase()}`];

    // e. Confirms the same token still authenticates through deviceStore via verifyDroneToken
    let nextCalled = false;
    let statusCode = null;
    let jsonBody = null;
    const req = {
      body: { drone_id: testDroneId },
      headers: { 'x-drone-token': testToken }
    };
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { jsonBody = data; return this; }
    };
    verifyDroneToken(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'verifyDroneToken must call next() for migrated token');
    assert.equal(req.authenticatedDroneId, testDroneId);

    // f. Confirms a wrong token is rejected
    let wrongNextCalled = false;
    let wrongStatusCode = null;
    let wrongJson = null;
    const wrongReq = {
      body: { drone_id: testDroneId },
      headers: { 'x-drone-token': 'wrong_imposter_token_value' }
    };
    const wrongRes = {
      status(code) { wrongStatusCode = code; return this; },
      json(data) { wrongJson = data; return this; }
    };
    verifyDroneToken(wrongReq, wrongRes, () => { wrongNextCalled = true; });
    assert.equal(wrongNextCalled, false, 'verifyDroneToken must NOT call next() on wrong token');
    assert.equal(wrongStatusCode, 401);
    assert.match(wrongJson.error, /invalid device token/);
  });

  await t.test('with LEGACY_ENV_TOKENS_ENABLED=false, drone authenticates only through DeviceStore', async () => {
    setLegacyEnvTokensEnabled(false);
    assert.equal(getLegacyEnvTokensEnabled(), false);

    // Set legacy env var for an unmigrated drone
    const legacyDroneId = 'Drone-Legacy-Only';
    const legacyToken = 'legacy_secret_token_1234567890';
    process.env.DRONE_DEVICE_TOKENS = JSON.stringify({ [legacyDroneId]: legacyToken });

    // Ensure it is NOT in deviceStore
    deviceStore.memoryDevices.delete(legacyDroneId);

    // Rejection of unmigrated drone when legacy fallback is disabled
    let legacyNext = false;
    let legacyCode = null;
    const legacyReq = {
      body: { drone_id: legacyDroneId },
      headers: { 'x-drone-token': legacyToken }
    };
    const legacyRes = {
      status(code) { legacyCode = code; return this; },
      json() { return this; }
    };
    verifyDroneToken(legacyReq, legacyRes, () => { legacyNext = true; });
    assert.equal(legacyNext, false);
    assert.equal(legacyCode, 401);

    // Now register in DeviceStore: must authenticate cleanly
    const registered = await deviceStore.registerDevice({
      device_id: 'Drone-Store-Verified',
      type: 'drone'
    });
    let storeNext = false;
    const storeReq = {
      body: { drone_id: 'Drone-Store-Verified' },
      headers: { 'x-drone-token': registered.raw_token }
    };
    const storeRes = { status() { return this; }, json() { return this; } };
    verifyDroneToken(storeReq, storeRes, () => { storeNext = true; });
    assert.equal(storeNext, true);
    assert.equal(storeReq.authenticatedDroneId, 'Drone-Store-Verified');

    // Restore legacy setting
    setLegacyEnvTokensEnabled(true);
    delete process.env.DRONE_DEVICE_TOKENS;
  });

  await t.test('enforces devices list response shape containing fingerprint and omitting full hash and raw token', async () => {
    const dev = await deviceStore.registerDevice({
      device_id: 'shape-test-dev',
      name: 'Shape Test Unit',
      type: 'phone'
    });

    const devices = await deviceStore.listDevices();
    const item = devices.find(d => d.device_id === 'shape-test-dev');
    assert.ok(item, 'Device must be listed');

    // Required fields: id, device_id, name, type, status, created_at, revoked_at, fingerprint
    assert.equal(item.id, 'shape-test-dev');
    assert.equal(item.device_id, 'shape-test-dev');
    assert.equal(item.name, 'Shape Test Unit');
    assert.equal(item.type, 'phone');
    assert.equal(item.status, 'active');
    assert.ok(item.created_at);
    assert.equal(item.revoked_at, null);

    // Fingerprint must be exactly 8 hex characters
    assert.ok(item.fingerprint, 'Fingerprint must be present');
    assert.match(item.fingerprint, /^[0-9a-fA-F]{8}$/);
    const expectedFingerprint = Device.hashToken(dev.raw_token).substring(0, 8);
    assert.equal(item.fingerprint, expectedFingerprint);

    // Strict security guarantee: full hash and raw token must NEVER be returned
    assert.equal(item.token_hash, undefined, 'token_hash must be undefined in list');
    assert.equal(item.raw_token, undefined, 'raw_token must be undefined in list');
  });
});
