const mongoose = require('mongoose');

let isConnected = false;
let isReconnecting = false;
let reconnectTimer = null;

/**
 * Connect to MongoDB with automatic retry and friendly diagnostics.
 */
async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ecowing';

  const options = {
    dbName: 'ecowing',
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4000,
    autoIndex: true
  };

  try {
    console.log(`[MongoDB] Connecting to: ${uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}...`);
    const conn = await mongoose.connect(uri, options);
    if (conn.connection.readyState === 1) {
      isConnected = true;
      console.log(`[MongoDB] ✅ Successfully connected to MongoDB!`);
      console.log(`[MongoDB] Host: ${conn.connection.host}`);
      console.log(`[MongoDB] Database Name: ${conn.connection.name}`);
      return conn;
    }
    return null;
  } catch (error) {
    isConnected = false;
    console.warn(`\n[MongoDB] ⚠️ Could not connect to MongoDB at: ${uri}`);
    console.warn(`[MongoDB] Note: Server is running in resilient mode with local fallback.`);
    console.warn(`[MongoDB] To connect live MongoDB:`);
    console.warn(`[MongoDB]   - Start local MongoDB (e.g. 'net start MongoDB' or 'mongod')`);
    console.warn(`[MongoDB]   - Or put your MongoDB Atlas string in .env: MONGODB_URI=mongodb+srv://...`);
    scheduleReconnect();
    return null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || isConnected || isReconnecting) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await attemptReconnect();
  }, 15000);
}

async function attemptReconnect() {
  if (isConnected || isReconnecting || mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ecowing';
  isReconnecting = true;
  try {
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000, dbName: 'ecowing' });
    if (conn.connection.readyState === 1) {
      isConnected = true;
      console.log(`[MongoDB] ✅ Connected to MongoDB successfully!`);
    }
  } catch (err) {
    isConnected = false;
    scheduleReconnect();
  } finally {
    isReconnecting = false;
  }
}

mongoose.connection.on('connected', () => {
  isConnected = true;
  console.log('[MongoDB] Connection state: Connected');
});

mongoose.connection.on('disconnected', () => {
  if (isConnected) {
    console.warn('[MongoDB] ⚠️ Connection dropped. Retrying in background...');
  }
  isConnected = false;
  scheduleReconnect();
});

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = {
  connectDB,
  isDbConnected,
  mongoose
};
