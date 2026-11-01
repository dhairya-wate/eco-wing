const crypto = require('crypto');

// Security: Operator authentication for drone control & registration
const ECOWING_OPERATOR_TOKEN = (process.env.ECOWING_OPERATOR_TOKEN || process.env.OPERATOR_TOKEN || '').trim();

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

/**
 * Middleware: Enforces per-drone device token on ingestion routes.
 * Uses constant-time comparison and environment-variable storage only.
 * Rejects missing or mismatched tokens, preventing Drone A from impersonating Drone B.
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

  const expectedToken = getExpectedDroneToken(droneId);
  if (!expectedToken) {
    return res.status(401).json({
      error: `Unauthorized: no device token configured for drone '${droneId}'.`
    });
  }

  if (!constantTimeCompare(String(token).trim(), expectedToken)) {
    return res.status(401).json({
      error: `Unauthorized: invalid device token for drone '${droneId}'.`
    });
  }

  req.authenticatedDroneId = droneId;
  next();
}

module.exports = {
  ECOWING_OPERATOR_TOKEN,
  validateOperatorTokenConfig,
  verifyOperatorToken,
  verifyDroneToken,
  constantTimeCompare,
  getExpectedDroneToken
};
