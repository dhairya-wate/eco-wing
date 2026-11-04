const crypto = require('crypto');
const { deviceStore } = require('../services/deviceStore');

// Security: Operator authentication for drone control & registration
const ECOWING_OPERATOR_TOKEN = (process.env.ECOWING_OPERATOR_TOKEN || process.env.OPERATOR_TOKEN || '').trim();

// Internal service-to-service token for detection service exchange
const DETECTION_SERVICE_TOKEN = (process.env.DETECTION_SERVICE_TOKEN || process.env.ECOWING_SERVICE_TOKEN || 'service_token_detection_system_sec_key_32_chars').trim();

function validateOperatorTokenConfig(token) {
  if (!token) {
    throw new Error(
      "CRITICAL SECURITY CONFIGURATION ERROR: 'ECOWING_OPERATOR_TOKEN' environment variable is not set. " +
      "A secure operator token is required for drone control and administrative operations. " +
      "Please generate a secure random token (at least 32 characters, e.g. python -c \"import secrets; print(secrets.token_urlsafe(32))\") " +
      "and set it in your environment or .env file before starting the application."
    );
  }
  if (token.length < 32) {
    throw new Error(
      `CRITICAL SECURITY CONFIGURATION ERROR: 'ECOWING_OPERATOR_TOKEN' is too short (${token.length} chars). ` +
      "The token must be at least 32 characters long to ensure adequate cryptographic entropy."
    );
  }
  const isRepeatedPattern = /^(.+?)\1+$/.test(token);
  if (isRepeatedPattern || new Set(token).size < 12) {
    throw new Error(
      "CRITICAL SECURITY CONFIGURATION ERROR: 'ECOWING_OPERATOR_TOKEN' has insufficient complexity or repetitive patterns. " +
      "The token must contain at least 12 distinct characters and cannot consist of repeating trivial sequences."
    );
  }
  return token;
}

// Enforce token validation on module startup
validateOperatorTokenConfig(ECOWING_OPERATOR_TOKEN);

function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function verifyOperatorToken(req, res, next) {
  const token = req.headers['x-operator-token'];
  if (!ECOWING_OPERATOR_TOKEN || !token) {
    return res.status(401).json({
      error: "Unauthorized: invalid or missing operator token. Provide 'X-Operator-Token' header."
    });
  }
  if (!constantTimeCompare(String(token).trim(), ECOWING_OPERATOR_TOKEN)) {
    return res.status(401).json({
      error: "Unauthorized: invalid or missing operator token. Provide 'X-Operator-Token' header."
    });
  }
  next();
}

/**
 * Resolves the expected device token for a specific drone ID from environment variables only.
 * Checks DRONE_TOKEN_<DRONE_ID> and DRONE_DEVICE_TOKENS (JSON or 'id:token,id2:token2').
 */
function getExpectedDroneToken(droneId) {
  if (!droneId || typeof droneId !== 'string') return null;
  const cleanId = droneId.trim();

  // 1. Direct environment variable: DRONE_TOKEN_<DRONE_ID>
  const envKey = `DRONE_TOKEN_${cleanId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  if (process.env[envKey] && process.env[envKey].trim()) {
    return process.env[envKey].trim();
  }

  // 2. Mapping from DRONE_DEVICE_TOKENS environment variable
  const rawTokens = process.env.DRONE_DEVICE_TOKENS || '';
  if (rawTokens.trim()) {
    const trimmed = rawTokens.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed[cleanId]) return String(parsed[cleanId]).trim();
      } catch (e) {}
    } else {
      for (const pair of trimmed.split(',')) {
        const [dId, dToken] = pair.split(':');
        if (dId && dToken && dId.trim().toLowerCase() === cleanId.toLowerCase()) {
          return dToken.trim();
        }
      }
    }
  }

  return null;
}

function verifyServiceToken(req, res, next) {
  const token = req.headers['x-service-token'] ||
    (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].substring(7).trim() : null);

  const opToken = req.headers['x-operator-token'];
  if (opToken && constantTimeCompare(String(opToken).trim(), ECOWING_OPERATOR_TOKEN)) {
    return next();
  }

  if (!token) {
    return res.status(401).json({
      error: "Unauthorized: missing service token. Provide 'X-Service-Token' header."
    });
  }

  if (!constantTimeCompare(String(token).trim(), DETECTION_SERVICE_TOKEN)) {
    return res.status(401).json({
      error: "Unauthorized: invalid service token."
    });
  }

  next();
}

// Migration flag: controls whether fallback to DRONE_DEVICE_TOKENS is active
let LEGACY_ENV_TOKENS_ENABLED = process.env.LEGACY_ENV_TOKENS_ENABLED !== 'false';

function setLegacyEnvTokensEnabled(val) {
  LEGACY_ENV_TOKENS_ENABLED = Boolean(val);
}

function getLegacyEnvTokensEnabled() {
  return LEGACY_ENV_TOKENS_ENABLED;
}

// Log a one-time deprecation warning at startup if the env var is set, without logging any token values
if (process.env.DRONE_DEVICE_TOKENS && process.env.DRONE_DEVICE_TOKENS.trim()) {
  console.warn(
    "[SECURITY DEPRECATION WARNING] 'DRONE_DEVICE_TOKENS' is deprecated and will be removed in a future release. " +
    "Please migrate drone device tokens to the Device store using migrateDroneTokens()."
  );
}

/**
 * Middleware: Enforces per-drone/device token on ingestion routes.
 * Checks new DeviceStore (MongoDB/hashed token) with fallback
 * to legacy environment variable tokens for zero-downtime migration.
 * Rejects missing or mismatched tokens, preventing Device A from impersonating Device B.
 */
function verifyDroneToken(req, res, next) {
  const droneId = req.body?.drone_id || req.headers['x-drone-id'] || (req.query && req.query.drone_id);
  if (!droneId || typeof droneId !== 'string') {
    return res.status(401).json({
      error: "Unauthorized: missing or invalid drone identifier ('drone_id')."
    });
  }

  const authHeader = req.headers['authorization'];
  let token = req.headers['x-drone-token'] || req.headers['x-device-token'];
  if (!token && authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else {
      token = authHeader.trim();
    }
  }

  if (!token) {
    return res.status(401).json({
      error: "Unauthorized: missing drone device token. Provide 'X-Drone-Token' or 'Authorization: Bearer <token>' header."
    });
  }

  const cleanToken = String(token).trim();

  // 1. Primary path: DeviceStore check with SHA-256 hash & constant-time comparison
  const storedDevice = deviceStore && typeof deviceStore.getDeviceRecordSync === 'function'
    ? deviceStore.getDeviceRecordSync(droneId)
    : null;

  if (storedDevice && storedDevice.status === 'active' && storedDevice.token_hash) {
    const presentedHash = crypto.createHash('sha256').update(cleanToken).digest('hex');
    const bufPresented = Buffer.from(presentedHash, 'hex');
    const bufStored = Buffer.from(storedDevice.token_hash, 'hex');
    if (bufPresented.length === bufStored.length && bufPresented.length > 0) {
      if (crypto.timingSafeEqual(bufPresented, bufStored)) {
        req.authenticatedDroneId = droneId;
        return next();
      }
    }
    return res.status(401).json({
      error: `Unauthorized: invalid device token for drone '${droneId}'.`
    });
  }

  // 2. Migration fallback path: Environment variables (DRONE_DEVICE_TOKENS, DRONE_TOKEN_<ID>)
  // Only active when LEGACY_ENV_TOKENS_ENABLED is true
  if (LEGACY_ENV_TOKENS_ENABLED) {
    const expectedToken = getExpectedDroneToken(droneId);
    if (expectedToken) {
      if (constantTimeCompare(cleanToken, expectedToken)) {
        req.authenticatedDroneId = droneId;
        return next();
      }
      return res.status(401).json({
        error: `Unauthorized: invalid device token for drone '${droneId}'.`
      });
    }
  }

  // 3. If MongoDB is ready and not found in memory/env, query DB
  if (deviceStore && deviceStore.isMongoReady()) {
    deviceStore.verifyDeviceToken(droneId, cleanToken).then(isValid => {
      if (isValid) {
        req.authenticatedDroneId = droneId;
        return next();
      }
      return res.status(401).json({
        error: `Unauthorized: invalid device token for drone '${droneId}'.`
      });
    }).catch(err => {
      return res.status(401).json({
        error: `Unauthorized: device token verification error.`
      });
    });
    return;
  }

  return res.status(401).json({
    error: `Unauthorized: no device token configured for drone '${droneId}'.`
  });
}

/**
 * Migration helper: loads DRONE_DEVICE_TOKENS into DeviceStore
 */
async function migrateDroneTokens() {
  const rawTokens = process.env.DRONE_DEVICE_TOKENS || '';
  if (!rawTokens.trim()) return [];

  const migrated = [];
  const trimmed = rawTokens.trim();
  let pairs = [];

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      pairs = Object.entries(parsed).map(([id, tok]) => ({ id, token: String(tok) }));
    } catch (e) {}
  } else {
    for (const pair of trimmed.split(',')) {
      const [dId, dToken] = pair.split(':');
      if (dId && dToken) pairs.push({ id: dId.trim(), token: dToken.trim() });
    }
  }

  const Device = require('../models/Device');
  for (const { id, token } of pairs) {
    try {
      const hash = Device.hashToken(token);
      if (deviceStore.isMongoReady()) {
        await Device.findOneAndUpdate(
          { device_id: id },
          {
            device_id: id,
            name: id,
            type: 'drone',
            token_hash: hash,
            status: 'active'
          },
          { upsert: true, new: true }
        );
      } else {
        deviceStore.memoryDevices.set(id, {
          device_id: id,
          name: id,
          type: 'drone',
          token_hash: hash,
          status: 'active',
          last_seen: null,
          created_at: new Date(),
          updated_at: new Date()
        });
      }
      migrated.push(id);
    } catch (e) {
      console.warn(`[Migration] Could not migrate drone ${id}:`, e.message);
    }
  }
  return migrated;
}

module.exports = {
  ECOWING_OPERATOR_TOKEN,
  DETECTION_SERVICE_TOKEN,
  LEGACY_ENV_TOKENS_ENABLED,
  setLegacyEnvTokensEnabled,
  getLegacyEnvTokensEnabled,
  validateOperatorTokenConfig,
  verifyOperatorToken,
  verifyServiceToken,
  verifyDroneToken,
  constantTimeCompare,
  getExpectedDroneToken,
  migrateDroneTokens
};
