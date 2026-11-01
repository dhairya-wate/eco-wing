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

const { createRateLimiter } = require('../../src/middleware/rateLimiter');
const Telemetry = require('../../src/models/Telemetry');
const {
  validateOperatorTokenConfig,
  verifyOperatorToken,
  verifyDroneToken,
  constantTimeCompare,
  getExpectedDroneToken
} = require('../../src/middleware/auth');
const { validateTarget } = require('../../src/routes/drone');
const { validateMongoUriConfig, allowedOrigins } = require('../../src/app');
const { verifySocketDroneAuth } = require('../../src/server');
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
    const app = require('../../src/app');
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      // Authorized origin
      const resAuth = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { 'Origin': 'http://localhost:8080', 'Connection': 'close' }
      });
      assert.equal(resAuth.status, 200);
      assert.equal(resAuth.headers.get('access-control-allow-origin'), 'http://localhost:8080');

      // Unauthorized origin
      const resUnauth = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { 'Origin': 'http://evil-attacker.com', 'Connection': 'close' }
      });
      assert.equal(resUnauth.status, 403);
      assert.equal(resUnauth.headers.get('access-control-allow-origin'), null);
      const body = await resUnauth.json();
      assert.equal(body.error, 'Forbidden');
      assert.match(body.message, /CORS policy violation/);
    } finally {
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      await new Promise(r => srv.close(r));
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

test('Infrastructure & Compose Hardening (E10, E11)', async (t) => {
  const fs = require('fs');
  const path = require('path');

  await t.test('package.json declares Node engine >=20.0.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    assert.ok(pkg.engines, 'package.json must contain engines field');
    assert.equal(pkg.engines.node, '>=20.0.0');
  });

  await t.test('docker-compose.yml pins mongo image, adds --auth flag, and specifies service_healthy healthcheck', () => {
    const composeCandidate = path.resolve(__dirname, '../../../..', 'docker-compose.yml');
    const composePath = fs.existsSync(composeCandidate) ? composeCandidate : path.resolve(__dirname, '../../..', 'docker-compose.yml');
    const composeContent = fs.readFileSync(composePath, 'utf-8');
    assert.match(composeContent, /image:\s*mongo:7\.0\.14-jammy/, 'MongoDB image must be pinned');
    assert.match(composeContent, /command:\s*\["--auth"\]/, 'MongoDB must run with --auth command flag');
    assert.match(composeContent, /healthcheck:/, 'MongoDB must have healthcheck');
    assert.match(composeContent, /db\.adminCommand\('ping'\)/, 'MongoDB healthcheck must ping adminCommand');
    assert.match(composeContent, /condition:\s*service_healthy/, 'backend depends_on must require service_healthy condition');
  });
});
test('Root Governance & CI Pipelines (E13)', async (t) => {
  const fs = require('fs');
  const path = require('path');
  const serviceDir = path.resolve(__dirname, '../..');
  const rootCandidate = path.resolve(__dirname, '../../..');
  const rootDir = fs.existsSync(path.join(rootCandidate, 'SECURITY.md')) ? rootCandidate : serviceDir;

  await t.test('root .env.example exists and contains required environment keys', () => {
    const envCandidate = path.join(rootDir, '.env.example');
    const envExamplePath = fs.existsSync(envCandidate) ? envCandidate : path.join(serviceDir, '.env.example');
    assert.ok(fs.existsSync(envExamplePath), '.env.example must exist in repository root or service root');
    const content = fs.readFileSync(envExamplePath, 'utf-8');
    assert.match(content, /ECOWING_OPERATOR_TOKEN=/);
    assert.match(content, /MONGO_URI=/);
    assert.match(content, /DRONE_DEVICE_TOKENS=/);
  });

  await t.test('LICENSE is not present in root directory', () => {
    const licensePath = path.join(rootDir, 'LICENSE');
    assert.strictEqual(fs.existsSync(licensePath), false, 'LICENSE must not exist in repository root');
  });

  await t.test('CI workflow file exists and defines test execution steps', () => {
    const ciPath = path.join(rootDir, '.github', 'workflows', 'ci.yml');
    assert.ok(fs.existsSync(ciPath), '.github/workflows/ci.yml must exist');
    const content = fs.readFileSync(ciPath, 'utf-8');
    assert.match(content, /npm test/);
    assert.match(content, /pytest test_drone_security\.py/);
  });
});

test('Trusted Proxy Topology & IP Extraction (OP-3)', async (t) => {
  const http = require('http');
  const app = require('../../src/app');
  const { isTrustedProxy, trustedProxySet } = require('../../src/app');

  await t.test('default trustedProxySet is empty, rejecting X-Forwarded-For spoofing', async () => {
    trustedProxySet.clear();
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { 'X-Forwarded-For': '203.0.113.195', 'Connection': 'close' }
      });
      assert.equal(res.status, 200);
      assert.equal(isTrustedProxy('127.0.0.1'), false);
    } finally {
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      await new Promise(r => srv.close(r));
    }
  });

  await t.test('accepts X-Forwarded-For only when peer socket matches exact trusted proxy IP', () => {
    trustedProxySet.clear();
    trustedProxySet.add('127.0.0.1');
    try {
      assert.equal(isTrustedProxy('127.0.0.1'), true);
      assert.equal(isTrustedProxy('192.168.1.100'), false);
      assert.equal(isTrustedProxy('172.18.0.5'), false);
    } finally {
      trustedProxySet.clear();
    }
  });
});

test('Nginx Reverse Proxy Configuration & Video Feed Gate (OP-2)', async (t) => {
  const fs = require('fs');
  const path = require('path');
  const nginxCandidate = path.resolve(__dirname, '../../../../deploy/nginx/nginx.conf');
  const nginxPath = fs.existsSync(nginxCandidate) ? nginxCandidate : path.resolve(__dirname, '../../../nginx.conf');
  const nginxConf = fs.readFileSync(nginxPath, 'utf-8');

  await t.test('nginx.conf defines client_max_body_size 5m', () => {
    assert.match(nginxConf, /client_max_body_size\s+5m;/);
  });

  await t.test('nginx.conf gates /video_feed with operator token and disables buffering', () => {
    assert.match(nginxConf, /location\s*=\s*\/video_feed\s*\{/);
    assert.match(nginxConf, /\$http_x_operator_token\s*=\s*""/);
    assert.match(nginxConf, /return\s*401/);
    assert.match(nginxConf, /proxy_buffering\s+off;/);
    assert.match(nginxConf, /proxy_cache\s+off;/);
    assert.match(nginxConf, /proxy_read_timeout\s+86400s;/);
  });
});


after(() => {
  setTimeout(() => process.exit(0), 100);
});
