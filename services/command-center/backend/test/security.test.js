const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
  'Drone-Alpha': 'drone_alpha_token_12345678901234567890',
  'Drone-Beta': 'drone_beta_token_12345678901234567890'
});

const {
  validateOperatorTokenConfig,
  verifyOperatorToken,
  verifyDroneToken,
  constantTimeCompare,
  getExpectedDroneToken
} = require('../middleware/auth');

const { validateTarget } = require('../routes/drone');

test('Operator Token Configuration Validation', async (t) => {
  await t.test('fails when operator token is empty', () => {
    assert.throws(() => validateOperatorTokenConfig(''), /is not set/);
  });

  await t.test('fails when operator token is shorter than 32 characters', () => {
    assert.throws(() => validateOperatorTokenConfig('short_token_123'), /too short/);
  });

  await t.test('fails when operator token is repetitive', () => {
    assert.throws(() => validateOperatorTokenConfig('abcd'.repeat(9)), /insufficient complexity/);
  });

  await t.test('succeeds with a valid high-entropy token', () => {
    const valid = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
    assert.equal(validateOperatorTokenConfig(valid), valid);
  });
});

test('Constant-Time Comparison', async (t) => {
  await t.test('returns true for identical strings', () => {
    assert.equal(constantTimeCompare('secret123', 'secret123'), true);
  });

  await t.test('returns false for different strings', () => {
    assert.equal(constantTimeCompare('secret123', 'wrong456'), false);
  });

  await t.test('returns false for different lengths safely', () => {
    assert.equal(constantTimeCompare('short', 'much_longer_string_value'), false);
  });
});

test('Drone Ingestion Authentication (E2)', async (t) => {
  await t.test('resolves configured drone tokens from environment', () => {
    assert.equal(getExpectedDroneToken('Drone-Alpha'), 'drone_alpha_token_12345678901234567890');
    assert.equal(getExpectedDroneToken('Drone-Beta'), 'drone_beta_token_12345678901234567890');
    assert.equal(getExpectedDroneToken('Unknown-Drone'), null);
  });

  await t.test('verifyDroneToken middleware rejects missing drone_id with 401', () => {
    let statusCode = null;
    let jsonBody = null;
    const req = { body: {}, headers: {} };
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { jsonBody = b; return this; }
    };
    verifyDroneToken(req, res, () => {});
    assert.equal(statusCode, 401);
    assert.match(jsonBody.error, /missing or invalid drone identifier/);
  });

  await t.test('verifyDroneToken middleware rejects missing token with 401', () => {
    let statusCode = null;
    let jsonBody = null;
    const req = { body: { drone_id: 'Drone-Alpha' }, headers: {} };
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { jsonBody = b; return this; }
    };
    verifyDroneToken(req, res, () => {});
    assert.equal(statusCode, 401);
    assert.match(jsonBody.error, /missing drone device token/);
  });

  await t.test('verifyDroneToken middleware rejects cross-drone token misuse with 401', () => {
    let statusCode = null;
    let jsonBody = null;
    // Drone-Alpha's token submitted with Drone-Beta ID
    const req = {
      body: { drone_id: 'Drone-Beta' },
      headers: { 'x-drone-token': 'drone_alpha_token_12345678901234567890' }
    };
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { jsonBody = b; return this; }
    };
    verifyDroneToken(req, res, () => {});
    assert.equal(statusCode, 401);
    assert.match(jsonBody.error, /invalid device token for drone 'Drone-Beta'/);
  });

  await t.test('verifyDroneToken middleware accepts valid token and attaches authenticated ID', () => {
    let nextCalled = false;
    const req = {
      body: { drone_id: 'Drone-Alpha' },
      headers: { 'x-drone-token': 'drone_alpha_token_12345678901234567890' }
    };
    const res = {
      status() { return this; },
      json() { return this; }
    };
    verifyDroneToken(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.authenticatedDroneId, 'Drone-Alpha');
  });
});

test('Target Address & Protocol Validation (SSRF & HTTPS Defense)', async (t) => {
  await t.test('rejects HTTPS targets for LAN drone devices', async () => {
    const res = await validateTarget('https://192.0.2.10:8080/stream');
    assert.equal(res.ok, false);
    assert.match(res.error, /Only unencrypted HTTP/);
  });

  await t.test('rejects user-info SSRF attempts', async () => {
    const res = await validateTarget('http://localhost@evil.com/stream');
    assert.equal(res.ok, false);
    assert.match(res.error, /User-info in URL is prohibited/);
  });

  await t.test('rejects non-allowlisted target IP', async () => {
    const res = await validateTarget('http://192.168.1.50:8080/stream');
    assert.equal(res.ok, false);
    assert.match(res.error, /not permitted by DRONE_TARGET_ALLOWLIST/);
  });
});
