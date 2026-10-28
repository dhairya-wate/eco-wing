const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const { router: apiRouter } = require('./routes/api');
const droneRouter = require('./routes/drone');
const { handleClient } = require('./videoStream');

const app = express();

// Middlewares
app.use(cors());

// Raw binary body parser for raw JPEG stream frames
app.use(express.raw({
  type: ['image/jpeg', 'image/png', 'application/octet-stream'],
  limit: '20mb'
}));

// Standard JSON body parser
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// MongoDB Connection with auto-reconnect & serverless caching
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ecowing';
const safeLogUri = MONGO_URI.replace(/:([^:@]+)@/, ':****@');

let isConnecting = false;
async function connectMongo() {
  if (mongoose.connection.readyState === 1 || isConnecting) return;
  isConnecting = true;
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 8000
    });
    console.log('[MongoDB] Connected successfully to database');
  } catch (err) {
    console.warn(`[MongoDB] Connection error: ${err.message}`);
  } finally {
    isConnecting = false;
  }
}

// Initial connection attempt
connectMongo();

// Serverless middleware: ensure DB connection is active before processing API requests
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api') && mongoose.connection.readyState !== 1) {
    await connectMongo();
  }
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  const isMongoConnected = mongoose.connection.readyState === 1;
  res.json({
    status: 'ok',
    service: 'ecowing-backend',
    mongodb: isMongoConnected ? 'connected' : 'disconnected',
    timestamp: new Date()
  });
});

// Camera video feed endpoint (MJPEG streaming)
app.get('/video_feed', handleClient);

// Mount API routes
app.use('/api/drone', droneRouter);
app.use('/api', apiRouter);

// Serve static frontend files (index.html, config.js, etc.)
app.use(express.static(path.join(__dirname, '..')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

module.exports = app;
module.exports.connectMongo = connectMongo;

