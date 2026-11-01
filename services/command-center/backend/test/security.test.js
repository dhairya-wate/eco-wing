const { createRateLimiter } = require('../middleware/rateLimiter');
const Telemetry = require('../models/Telemetry');
process.env.NODE_ENV = 'test';
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

const {
  validateTarget
} = require('../routes/drone');
const { validateMongoUriConfig, allowedOrigins } = require('../app');
const { verifySocketDroneAuth } = require('../server');
const {
  validateCanonicalDetectionEvent,
  validateDetectionPayload
} = require('../validators/detectionValidator');

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

test('MongoDB Credentials Validation (Startup Check)', async (t) => {
  await t.test('fails when MONGO_URI is missing or empty', () => {
    assert.throws(() => validateMongoUriConfig(''), /is missing/);
    assert.throws(() => validateMongoUriConfig(null), /is missing/);
  });

  await t.test('fails when MONGO_URI has no user credentials', () => {
    assert.throws(
      () => validateMongoUriConfig('mongodb://mongodb:27017/ecowing'),
      /must include credentials/
    );
    assert.throws(
      () => validateMongoUriConfig('mongodb://127.0.0.1:27017/ecowing'),
      /must include credentials/
    );
  });

  await t.test('succeeds when MONGO_URI contains credentials', () => {
    const local = 'mongodb://ecowing_admin:secure_pass123@mongodb:27017/ecowing?authSource=admin';
    assert.equal(validateMongoUriConfig(local), local);

    const srv = 'mongodb+srv://admin_user:secret_password@cluster0.abc.mongodb.net/ecowing?retryWrites=true';
    assert.equal(validateMongoUriConfig(srv), srv);
  });
});

test('CORS Allowlist Validation (E-NEW1)', async (t) => {
  await t.test('allowedOrigins list contains expected default origins', () => {
    assert.ok(allowedOrigins.includes('http://localhost:8080'));
    assert.ok(allowedOrigins.includes('http://127.0.0.1:8080'));
    assert.ok(allowedOrigins.includes('http://localhost:3000'));
    assert.ok(allowedOrigins.includes('http://127.0.0.1:3000'));
  });

  await t.test('wildcard origin is NOT present in allowedOrigins', () => {
    assert.equal(allowedOrigins.includes('*'), false);
  });

  await t.test('HTTP requests with unauthorized Origin are rejected with 403 and no CORS header', async () => {
    const http = require('http');
    const app = require('../app');
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      // Authorized origin
      const resAuth = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { 'Origin': 'http://localhost:8080' }
      });
      assert.equal(resAuth.status, 200);
      assert.equal(resAuth.headers.get('access-control-allow-origin'), 'http://localhost:8080');

      // Unauthorized origin
      const resUnauth = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { 'Origin': 'http://evil-attacker.com' }
      });
      assert.equal(resUnauth.status, 403);
      assert.equal(resUnauth.headers.get('access-control-allow-origin'), null);
      const body = await resUnauth.json();
      assert.equal(body.error, 'Forbidden');
      assert.match(body.message, /CORS policy violation/);
    } finally {
      srv.close();
    }
  });
});

test('Socket.IO Drone Event Device Token Verification (E2 & E-NEW1)', async (t) => {
  await t.test('verifySocketDroneAuth rejects missing drone_id', () => {
    const socket = { droneId: null, droneToken: null, handshake: { auth: {} } };
    const res = verifySocketDroneAuth(socket, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /missing or invalid drone identifier/);
  });

  await t.test('verifySocketDroneAuth rejects missing token', () => {
    const socket = { droneId: null, droneToken: null, handshake: { auth: {} } };
    const res = verifySocketDroneAuth(socket, { drone_id: 'Drone-Alpha' });
    assert.equal(res.ok, false);
    assert.match(res.error, /missing drone device token/);
  });

  await t.test('verifySocketDroneAuth rejects invalid token', () => {
    const socket = { droneId: null, droneToken: null, handshake: { auth: {} } };
    const res = verifySocketDroneAuth(socket, { drone_id: 'Drone-Alpha', token: 'invalid_token_12345' });
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid device token for drone 'Drone-Alpha'/);
  });

  await t.test('verifySocketDroneAuth rejects cross-drone token misuse', () => {
    const socket = { droneId: null, droneToken: null, handshake: { auth: {} } };
    // Drone-Alpha's token used with Drone-Beta ID
    const res = verifySocketDroneAuth(socket, {
      drone_id: 'Drone-Beta',
      token: 'drone_alpha_token_12345678901234567890'
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid device token for drone 'Drone-Beta'/);
  });

  await t.test('verifySocketDroneAuth succeeds with valid token', () => {
    const socket = { droneId: null, droneToken: null, handshake: { auth: {} } };
    const res = verifySocketDroneAuth(socket, {
      drone_id: 'Drone-Alpha',
      token: 'drone_alpha_token_12345678901234567890'
    });
    assert.equal(res.ok, true);
    assert.equal(res.droneId, 'Drone-Alpha');
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

test('Video Feed Operator Auth Gate (/video_feed)', async (t) => {
  await t.test('verifyOperatorToken rejects request with missing X-Operator-Token with 401', () => {
    let statusCode = null;
    let jsonBody = null;
    const req = { headers: {} };
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { jsonBody = b; return this; }
    };
    verifyOperatorToken(req, res, () => {});
    assert.equal(statusCode, 401);
    assert.match(jsonBody.error, /invalid or missing operator token/);
  });

  await t.test('verifyOperatorToken rejects request with invalid X-Operator-Token with 401', () => {
    let statusCode = null;
    let jsonBody = null;
    const req = { headers: { 'x-operator-token': 'wrong_token_12345' } };
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { jsonBody = b; return this; }
    };
    verifyOperatorToken(req, res, () => {});
    assert.equal(statusCode, 401);
    assert.match(jsonBody.error, /invalid or missing operator token/);
  });

  await t.test('verifyOperatorToken accepts request with valid X-Operator-Token', () => {
    let nextCalled = false;
    const req = { headers: { 'x-operator-token': 'secure_test_operator_token_9xK2mP7qR4vL8wZ1' } };
    const res = {
      status() { return this; },
      json() { return this; }
    };
    verifyOperatorToken(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});

test('Canonical Detection Event Schema Validation', async (t) => {
  const validEvent = {
    event_id: '12345678-1234-4234-8234-123456789abc',
    drone_id: 'Drone-Alpha',
    source: 'camera',
    observed_at: '2026-11-01T04:00:00.000Z',
    taxonomy_version: '1.0.0',
    classification_method: 'coco_mapping',
    items: [
      {
        class_id: 'bottle',
        coco_label: 'bottle',
        confidence: 0.95,
        bbox: [100, 150, 200, 300],
        category: 'Container',
        material: 'plastic',
        recyclable: 'yes',
        biodegradable: 'no'
      }
    ]
  };

  await t.test('accepts valid canonical detection event', () => {
    const res = validateCanonicalDetectionEvent(validEvent);
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);

    const payloadRes = validateDetectionPayload(validEvent);
    assert.equal(payloadRes.valid, true);
    assert.equal(payloadRes.isCanonical, true);
  });

  await t.test('rejects missing required event_id', () => {
    const bad = { ...validEvent };
    delete bad.event_id;
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('event_id')));
  });

  await t.test('rejects non-UUIDv4 event_id', () => {
    const bad = { ...validEvent, event_id: 'not-a-valid-uuid' };
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('UUIDv4')));
  });

  await t.test('rejects confidence outside [0.0, 1.0] and non-finite values', () => {
    const badHigh = {
      ...validEvent,
      items: [{ ...validEvent.items[0], confidence: 1.5 }]
    };
    assert.equal(validateCanonicalDetectionEvent(badHigh).valid, false);

    const badNegative = {
      ...validEvent,
      items: [{ ...validEvent.items[0], confidence: -0.1 }]
    };
    assert.equal(validateCanonicalDetectionEvent(badNegative).valid, false);

    const badPct = {
      ...validEvent,
      items: [{ ...validEvent.items[0], confidence: 50 }]
    };
    assert.equal(validateCanonicalDetectionEvent(badPct).valid, false);

    const badNaN = {
      ...validEvent,
      items: [{ ...validEvent.items[0], confidence: NaN }]
    };
    assert.equal(validateCanonicalDetectionEvent(badNaN).valid, false);
  });

  await t.test('rejects unknown class_id not in canonical taxonomy', () => {
    const bad = {
      ...validEvent,
      items: [{ ...validEvent.items[0], class_id: 'plastic_wrapper' }]
    };
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('canonical taxonomy identifier')));
  });

  await t.test('rejects invalid source enum', () => {
    const bad = { ...validEvent, source: 'satellite' };
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('source')));
  });

  await t.test('rejects invalid bbox format', () => {
    const bad = {
      ...validEvent,
      items: [{ ...validEvent.items[0], bbox: [10, 20] }]
    };
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('bbox')));
  });
});

const { CommandManager } = require('../services/commandManager');

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

test('Telemetry Model TTL Index Configuration (E8)', async (t) => {
  await t.test('has configurable TTL seconds defaulting to 7 days', () => {
    assert.equal(typeof Telemetry.TELEMETRY_TTL_SECONDS, 'number');
    assert.equal(Telemetry.TELEMETRY_TTL_SECONDS, 604800);
  });

  await t.test('declares schema TTL index on timestamp with expireAfterSeconds', () => {
    const indexes = Telemetry.schema.indexes();
    const ttlIndex = indexes.find(entry => entry[0] && entry[0].timestamp === 1 && typeof entry[1].expireAfterSeconds === 'number');
    assert.ok(ttlIndex, 'TTL index on timestamp must be defined');
    assert.equal(ttlIndex[1].expireAfterSeconds, Telemetry.TELEMETRY_TTL_SECONDS);
  });
});

test('Ingestion Rate Limiting & Body Limits (E7)', async (t) => {
  await t.test('createRateLimiter enforces window and max limits with 429 and Retry-After', () => {
    const limiter = createRateLimiter({ windowMs: 5000, max: 2 });
    const req = { ip: '1.2.3.4', authenticated_drone_id: 'Test-Drone' };
    const headers = {};
    let status = null;
    let body = null;
    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      status: (c) => { status = c; return { json: (j) => { body = j; } }; }
    };

    let nextCount = 0;
    limiter(req, res, () => { nextCount++; });
    limiter(req, res, () => { nextCount++; });
    assert.equal(nextCount, 2);

    limiter(req, res, () => { nextCount++; });
    assert.equal(nextCount, 2);
    assert.equal(status, 429);
    assert.equal(body.error, 'Too Many Requests');
    assert.ok(headers['Retry-After'] >= 1);
    limiter.cleanup();
  });

  await t.test('separate keys/drones maintain independent rate limit counters', () => {
    const limiter = createRateLimiter({ windowMs: 5000, max: 1 });
    const req1 = { authenticated_drone_id: 'Drone-Alpha' };
    const req2 = { authenticated_drone_id: 'Drone-Beta' };
    let c1 = 0, c2 = 0;
    limiter(req1, { setHeader: () => {} }, () => { c1++; });
    limiter(req2, { setHeader: () => {} }, () => { c2++; });
    assert.equal(c1, 1);
    assert.equal(c2, 1);
    limiter.cleanup();
  });
});
