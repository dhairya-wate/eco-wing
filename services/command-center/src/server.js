const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const app = require('./app');
const Drone = require('./models/Drone');
const Telemetry = require('./models/Telemetry');
const Detection = require('./models/Detection');
const { broadcastFrame } = require('./videoStream');
const { computeDashboardStats } = require('./routes/api');
const { allowedOrigins } = require('./app');
const { getExpectedDroneToken, constantTimeCompare } = require('./middleware/auth');

const server = http.createServer(app);

// E-NEW1: Configure Socket.IO with restricted CORS allowlist
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  maxHttpBufferSize: 1e7 // 10MB for raw binary frames if streamed over WebSocket
});

// Attach io to express app so routes can broadcast events
app.set('io', io);

// Socket.IO event handling
let nextSocketEventId = 1;

/**
 * Validates drone device token on incoming Socket.IO events.
 * Prevents unauthenticated telemetry, detection, or frame injection over WebSockets.
 */
function verifySocketDroneAuth(socket, data) {
  const droneId = data?.drone_id || socket?.droneId;
  const token = data?.token || socket?.droneToken || socket?.handshake?.auth?.token || socket?.handshake?.headers?.['x-drone-token'];

  if (!droneId || typeof droneId !== 'string') {
    return { ok: false, error: "Unauthorized: missing or invalid drone identifier ('drone_id')." };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Unauthorized: missing drone device token.' };
  }
  const expectedToken = getExpectedDroneToken(droneId);
  if (!expectedToken) {
    return { ok: false, error: `Unauthorized: no device token configured for drone '${droneId}'.` };
  }
  if (!constantTimeCompare(String(token).trim(), expectedToken)) {
    return { ok: false, error: `Unauthorized: invalid device token for drone '${droneId}'.` };
  }
  return { ok: true, droneId: droneId.trim(), token: token.trim() };
}

io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // Allow a drone client to identify itself (requires device token)
  socket.on('register_drone', async (data) => {
    const auth = verifySocketDroneAuth(socket, data);
    if (!auth.ok) {
      return socket.emit('drone:auth_error', { error: auth.error });
    }

    const droneId = auth.droneId;
    socket.join(`drone:${droneId}`);
    socket.droneId = droneId;
    socket.droneToken = auth.token;
    console.log(`[Socket.IO] Drone registered and authenticated: ${droneId}`);

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

  // Direct drone telemetry stream over WebSocket (requires device token)
  socket.on('drone:telemetry', async (data) => {
    const auth = verifySocketDroneAuth(socket, data);
    if (!auth.ok) {
      return socket.emit('drone:auth_error', { error: auth.error });
    }

    try {
      const droneId = auth.droneId;

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

  // Direct drone waste detection event over WebSocket (requires device token)
  socket.on('drone:detection', async (data) => {
    const auth = verifySocketDroneAuth(socket, data);
    if (!auth.ok) {
      return socket.emit('drone:auth_error', { error: auth.error });
    }

    try {
      const event_id = data.event_id || nextSocketEventId++;
      const detection = new Detection({
        event_id,
        drone_id: auth.droneId,
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

  // Direct drone camera frame stream over WebSocket (requires device token)
  socket.on('drone:frame', (data) => {
    const auth = verifySocketDroneAuth(socket, data);
    if (!auth.ok) {
      return socket.emit('drone:auth_error', { error: auth.error });
    }
    if (data?.frame || (typeof data === 'string' && data)) {
      broadcastFrame(data.frame || data);
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

// Drone signal watchdog: detects lost telemetry links after 12 seconds of silence (unref for clean tests)
const watchdogInterval = setInterval(async () => {
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
if (watchdogInterval && typeof watchdogInterval.unref === 'function') {
  watchdogInterval.unref();
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ecowing';
    const safeLogUri = MONGO_URI.replace(/:([^:@]+)@/, ':****@');
    console.log(`====================================================`);
    console.log(` EcoWing Drone Fleet Command Center Backend Running`);
    console.log(` Port: ${PORT}`);
    console.log(` API Base: http://localhost:${PORT}/api`);
    console.log(` Video Feed: http://localhost:${PORT}/video_feed`);
    console.log(` MongoDB: ${safeLogUri}`);
    console.log(`====================================================`);
  });
}

module.exports = { server, io, verifySocketDroneAuth };
