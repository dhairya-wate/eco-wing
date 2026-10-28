const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const { router: apiRouter } = require('./routes/api');
const droneRouter = require('./routes/drone');
const { handleClient, broadcastFrame } = require('./videoStream');
const Drone = require('./models/Drone');
const Telemetry = require('./models/Telemetry');
const Detection = require('./models/Detection');
const { computeDashboardStats } = require('./routes/api');

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // 10MB for raw binary frames if streamed over WebSocket
});

// Attach io to express app so routes can broadcast events
app.set('io', io);

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
const path = require('path');
app.use(express.static(path.join(__dirname, '..')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Socket.IO event handling
let nextSocketEventId = 1;

io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // Allow a drone client to identify itself
  socket.on('register_drone', async (data) => {
    const droneId = data?.drone_id || 'Drone-01';
    socket.join(`drone:${droneId}`);
    socket.droneId = droneId;
    console.log(`[Socket.IO] Drone registered: ${droneId}`);

    try {
      await Drone.findOneAndUpdate(
        { drone_id: droneId },
        { is_connected: true, last_seen: new Date(), status: data?.status || 'Idle' },
        { upsert: true }
      );
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
    } catch (e) {
      console.error('Error on drone socket registration:', e);
    }
  });

  // Direct drone telemetry stream over WebSocket
  socket.on('drone:telemetry', async (data) => {
    try {
      const droneId = data.drone_id || socket.droneId || 'Drone-01';

      // Save to MongoDB
      const record = new Telemetry({
        ...data,
        drone_id: droneId,
        timestamp: new Date()
      });
      await record.save();

      // Update Drone document
      const drone = await Drone.findOneAndUpdate(
        { drone_id: droneId },
        {
          status: data.status || 'Flying',
          battery_pct: data.battery_pct != null ? data.battery_pct : 100,
          is_connected: true,
          last_seen: new Date(),
          telemetry: data
        },
        { upsert: true, new: true }
      );

      // Broadcast to web dashboard
      const allDrones = await Drone.find();
      const all_drones = {};
      allDrones.forEach(d => {
        all_drones[d.drone_id] = {
          status: d.status,
          battery_pct: d.battery_pct
        };
      });

      const activeDrone = allDrones.find(d => d.is_active) || drone;

      io.emit('telemetry_update', {
        active_drone: activeDrone.drone_id,
        all_drones: all_drones,
        telemetry: activeDrone.telemetry
      });
    } catch (err) {
      console.error('Error handling drone:telemetry via socket:', err);
    }
  });

  // Direct drone waste detection event over WebSocket
  socket.on('drone:detection', async (data) => {
    try {
      const event_id = data.event_id || nextSocketEventId++;
      const detection = new Detection({
        event_id,
        drone_id: data.drone_id || socket.droneId || 'Drone-01',
        class_name: data.class_name,
        confidence: data.confidence,
        center: data.center,
        timestamp: data.timestamp || new Date().toISOString().replace('T', ' ').substring(0, 19)
      });
      await detection.save();

      // Broadcast to frontend
      io.emit('new_detection', detection.toEventJSON());
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
    } catch (err) {
      console.error('Error handling drone:detection via socket:', err);
    }
  });

  // Direct drone camera frame stream over WebSocket
  socket.on('drone:frame', (data) => {
    if (data) {
      broadcastFrame(data);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    if (socket.droneId) {
      try {
        await Drone.findOneAndUpdate(
          { drone_id: socket.droneId },
          { is_connected: false, status: 'Idle' }
        );
        const stats = await computeDashboardStats();
        io.emit('stats_update', stats);
      } catch (e) {}
    }
  });
});

// Drone signal watchdog: detects lost telemetry links after 12 seconds of silence
setInterval(async () => {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const timeoutThreshold = new Date(Date.now() - 12000);
    const inactiveDrones = await Drone.find({
      is_connected: true,
      last_seen: { $lt: timeoutThreshold }
    });

    if (inactiveDrones.length > 0) {
      for (const d of inactiveDrones) {
        d.is_connected = false;
        d.status = 'Idle';
        if (d.telemetry) d.telemetry.status = 'Idle';
        await d.save();
        console.log(`[Watchdog] Drone ${d.drone_id} signal timed out (marked Idle)`);
      }

      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
      io.emit('telemetry_update', {
        active_drone: stats.telemetry?.drone_id || null,
        all_drones: stats.all_drones,
        telemetry: stats.telemetry
      });
      io.emit('drone_status_change', { message: 'Drone telemetry link lost' });
    }
  } catch (err) {
    // quiet
  }
}, 4000);

// MongoDB Connection with auto-reconnect (supports local MongoDB & MongoDB Atlas)
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ecowing';
const safeLogUri = MONGO_URI.replace(/:([^:@]+)@/, ':****@');

async function connectMongo() {
  console.log(`[MongoDB] Connecting to ${safeLogUri}...`);
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000
    });
    console.log('[MongoDB] Connected successfully to database');
  } catch (err) {
    console.warn(`[MongoDB] Connection error: ${err.message}. Retrying in 5 seconds...`);
    setTimeout(connectMongo, 5000);
  }
}

connectMongo();

mongoose.connection.on('disconnected', () => {
  console.warn('[MongoDB] Disconnected from MongoDB. Reconnecting...');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` EcoWing Drone Fleet Command Center Backend Running`);
  console.log(` Port: ${PORT}`);
  console.log(` API Base: http://localhost:${PORT}/api`);
  console.log(` Video Feed: http://localhost:${PORT}/video_feed`);
  console.log(` MongoDB: ${safeLogUri}`);
  console.log(`====================================================`);
});

