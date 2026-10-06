require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

// MongoDB Connection
const { connectDB, isDbConnected } = require('./config/db');

// Modular Route Handlers
const authRoutes = require('./routes/authRoutes');
const droneRoutes = require('./routes/droneRoutes');
const cameraRoutes = require('./routes/cameraRoutes');
const detectionRoutes = require('./routes/detectionRoutes');
const telemetryRoutes = require('./routes/telemetryRoutes');
const missionRoutes = require('./routes/missionRoutes');
const exportRoutes = require('./routes/exportRoutes');
const footageRoutes = require('./routes/footageRoutes');
const videoFeedRoutes = require('./routes/videoFeed');

// Models & Services
const Drone = require('./models/Drone');
const Detection = require('./models/Detection');
const User = require('./models/User');
const statsService = require('./db/statsService');

const app = express();
const server = http.createServer(app);

// Setup Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
app.set('socketio', io);
app.set('activeDroneId', 'Drone-01');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log incoming API requests in development
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/video_feed') {
      console.log(`[HTTP] ${req.method} ${req.path}`);
    }
    next();
  });
}

// Health & Database Status route
app.get('/api/health', async (req, res) => {
  let dbStats = { connected: false, message: 'Disconnected' };
  if (isDbConnected()) {
    try {
      const userCount = await User.countDocuments();
      const droneCount = await Drone.countDocuments();
      const detectionCount = await Detection.countDocuments({ status: { $ne: 'cleared' } });
      dbStats = {
        connected: true,
        database: 'MongoDB',
        users: userCount,
        drones: droneCount,
        detections: detectionCount
      };
    } catch (e) {
      dbStats = { connected: true, error: e.message };
    }
  }

  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    database: dbStats,
    uptime_seconds: process.uptime()
  });
});

// Mount modular API routes
app.use('/api/auth', authRoutes);
app.use('/api/drone', droneRoutes);
app.use('/api/drones', droneRoutes);
app.use('/api/camera', cameraRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/missions', missionRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/footage', footageRoutes);
app.use('/api', detectionRoutes); // /api/events, /api/detections, /api/feed/clear, /api/stats, /api/chart_data
app.use('/', videoFeedRoutes);     // /video_feed, /video_feed/snapshot

// Serve static frontend files
app.use(express.static(path.join(__dirname)));

// Route for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io Events
io.on('connection', async (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // Send initial real stats on connection
  try {
    const activeDroneId = app.get('activeDroneId') || null;
    const payload = await statsService.getStatsPayload(activeDroneId);
    socket.emit('stats_update', payload);
  } catch (e) {}

  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

// Periodic heartbeat / telemetry sync with connected drones (if active)
setInterval(async () => {
  if (io.engine.clientsCount > 0) {
    try {
      const activeDroneId = app.get('activeDroneId') || null;
      const statsPayload = await statsService.getStatsPayload(activeDroneId);
      io.emit('stats_update', statsPayload);
    } catch (e) {}
  }
}, 5000);

// Optional development-only simulation (DISABLED by default in production)
if (process.env.ENABLE_DEV_SIMULATION === 'true' && process.env.NODE_ENV !== 'production') {
  console.log('[Dev Simulation] Simulation mode explicitly enabled via ENABLE_DEV_SIMULATION=true');
}

// Start HTTP server & connect to MongoDB
const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  console.log(`\n============================================================`);
  console.log(`🚀 EcoWing Command Center Server Running on Port ${PORT}`);
  console.log(`🌐 Local Web Dashboard: http://localhost:${PORT}`);
  console.log(`📊 Health Endpoint:    http://localhost:${PORT}/api/health`);
  console.log(`============================================================\n`);

  // Connect to MongoDB
  await connectDB();
});

module.exports = { app, server };
