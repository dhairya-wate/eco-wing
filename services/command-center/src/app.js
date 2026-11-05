const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Locate and load .env file from either backend/.env or root .env
const envPaths = [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    break;
  }
}

const { router: apiRouter } = require('./routes/api');
const droneRouter = require('./routes/drone');
const deviceRouter = require('./routes/devices');
const { handleClient } = require('./videoStream');
const detectionStore = require('./detectionStore');
const { verifyOperatorToken } = require('./middleware/auth');

const app = express();

// Trusted proxy topology: exact IP matching (OP-3)
// X-Forwarded-For is trusted ONLY when the direct peer socket is an explicitly configured trusted proxy IP.
const rawTrustedProxies = process.env.ECOWING_TRUSTED_PROXIES || process.env.TRUSTED_PROXIES || '';
const trustedProxySet = new Set(
  rawTrustedProxies.split(',').map(s => s.trim().toLowerCase().replace(/^::ffff:/, '')).filter(Boolean)
);

function isTrustedProxy(ip) {
  if (!ip) return false;
  const clean = ip.trim().toLowerCase().replace(/^::ffff:/, '');
  return trustedProxySet.has(clean);
}

app.set('trust proxy', (ip) => {
  return isTrustedProxy(ip);
});

// E-NEW1: Restricted CORS configuration from environment allowlist
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
const rawCors = process.env.CORS_ORIGINS || process.env.ECOWING_CORS_ORIGINS || '';
const allowedOrigins = rawCors
  ? rawCors.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : DEFAULT_CORS_ORIGINS;

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. curl, server-to-server) with no origin header
    if (!origin) return callback(null, true);
    const norm = origin.trim().toLowerCase();
    if (allowedOrigins.includes(norm)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS policy violation: Origin '${origin}' is not permitted.`));
  },
  credentials: true
}));

// E7: Restrict request body sizes to 5MB (mitigates memory exhaustion and payload DOS)
// Raw binary body parser for raw JPEG stream frames
app.use(express.raw({
  type: ['image/jpeg', 'image/png', 'application/octet-stream'],
  limit: '5mb'
}));

// Standard JSON body parser
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

/**
 * Startup check: Validates that MONGO_URI includes credentials (user:password@).
 * Uncredentialed access is strictly prohibited.
 */
function validateMongoUriConfig(uri) {
  if (!uri || typeof uri !== 'string') {
    throw new Error("CRITICAL SECURITY ERROR: 'MONGO_URI' environment variable is missing.");
  }
  const cleanUri = uri.trim();
  const hasCredentials = /^mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@/.test(cleanUri);
  if (!hasCredentials) {
    throw new Error(
      "CRITICAL SECURITY CONFIGURATION ERROR: 'MONGO_URI' must include credentials " +
      "(e.g. mongodb://user:password@host:27017/ecowing?authSource=admin). " +
      "Uncredentialed database access is strictly prohibited."
    );
  }
  return cleanUri;
}

// MongoDB Connection with auto-reconnect & serverless caching
const ATLAS_URI = 'mongodb+srv://ecowing:ecowing-123@cluster0.rsub9dy.mongodb.net/ecowing?retryWrites=true&w=majority';
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || ATLAS_URI;

// Enforce startup credential check
validateMongoUriConfig(MONGO_URI);

const safeLogUri = MONGO_URI.replace(/:([^:@]+)@/, ':****@');

let isConnecting = false;
async function connectMongo() {
  if (mongoose.connection.readyState === 1 || isConnecting) return;
  isConnecting = true;
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    console.log('[MongoDB] Connected successfully to database');
  } catch (err) {
    console.warn(`[MongoDB] Connection notice (${safeLogUri}): ${err.message}`);
  } finally {
    isConnecting = false;
  }
}

// Initial connection attempt (skip in test mode to prevent background network timeouts)
if (process.env.NODE_ENV !== 'test') {
  connectMongo();
}

// Serverless middleware: attempt DB connection before processing API requests
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api') && mongoose.connection.readyState !== 1) {
    connectMongo().catch(() => {});
  }
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  const isMongoConnected = mongoose.connection.readyState === 1;
  const stats = detectionStore.getStats();
  res.json({
    status: 'ok',
    service: 'ecowing-backend',
    mongodb: isMongoConnected ? 'connected' : 'disconnected',
    database_mode: isMongoConnected ? 'mongodb_atlas' : 'persistent_store',
    total_detections_saved: stats.total_unique,
    timestamp: new Date()
  });
});

// Camera video feed endpoint (MJPEG streaming - protected by operator token)
app.get('/video_feed', verifyOperatorToken, handleClient);

// Mount API routes
app.use('/api/drone', droneRouter);
app.post('/api/telemetry', (req, res, next) => { req.url = '/telemetry'; droneRouter(req, res, next); });
app.post('/api/detection', (req, res, next) => { req.url = '/detection'; droneRouter(req, res, next); });
app.post('/api/stream-frame', (req, res, next) => { req.url = '/stream-frame'; droneRouter(req, res, next); });
app.use('/api', apiRouter);
app.use('/api', deviceRouter);

// Serve static frontend files (index.html, config.js, etc.)
app.use(express.static(path.join(__dirname, '..')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Central error handling middleware (handles JSON parse errors, CORS rejection, and 413 Payload Too Large)
app.use((err, req, res, next) => {
  if (err.message && err.message.startsWith('CORS policy violation')) {
    return res.status(403).json({
      status: 'error',
      error: 'Forbidden',
      message: err.message
    });
  }
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({
      status: 'error',
      error: 'Payload Too Large',
      message: 'Request body exceeds the maximum permitted limit of 5MB.'
    });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      status: 'error',
      error: 'Bad Request',
      message: 'Malformed JSON payload.'
    });
  }
  next(err);
});

module.exports = app;
module.exports.connectMongo = connectMongo;
module.exports.validateMongoUriConfig = validateMongoUriConfig;
module.exports.allowedOrigins = allowedOrigins;
module.exports.isTrustedProxy = isTrustedProxy;
module.exports.trustedProxySet = trustedProxySet;
