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

function verifyOperatorToken(req, res, next) {
  const token = req.headers['x-operator-token'];
  if (!ECOWING_OPERATOR_TOKEN || !token) {
    return res.status(401).json({
      error: "Unauthorized: invalid or missing operator token. Provide 'X-Operator-Token' header."
    });
  }
  const tokenBuf = Buffer.from(String(token).trim());
  const secretBuf = Buffer.from(ECOWING_OPERATOR_TOKEN);
  if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
    return res.status(401).json({
      error: "Unauthorized: invalid or missing operator token. Provide 'X-Operator-Token' header."
    });
  }
  next();
}

module.exports = {
  ECOWING_OPERATOR_TOKEN,
  validateOperatorTokenConfig,
  verifyOperatorToken
};
