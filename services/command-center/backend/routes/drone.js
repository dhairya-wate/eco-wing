const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Detection = require('../models/Detection');
const Drone = require('../models/Drone');
const Telemetry = require('../models/Telemetry');
const { broadcastFrame } = require('../videoStream');
const { computeDashboardStats } = require('./api');
const detectionStore = require('../detectionStore');

// In-memory drone state when MongoDB is offline
const memoryDrones = new Map();

let nextEventId = 1;

// Initialize nextEventId from highest event_id in database
(async () => {
  try {
    const highest = await Detection.findOne().sort({ event_id: -1 });
    if (highest && highest.event_id) {
      nextEventId = highest.event_id + 1;
    }
  } catch (e) {}
})();

/**
 * GET /api/drone/info
 * Returns connection info and ingestion endpoints for drone pilots & onboard companion computers
 */
router.get('/info', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const proto = req.protocol || 'http';
  const base = `${proto}://${host}`;

  res.json({
    status: 'online',
    base_url: base,
    endpoints: {
      telemetry: `${base}/api/drone/telemetry`,
      detection: `${base}/api/drone/detection`,
      stream_frame: `${base}/api/drone/stream-frame`,
      connect: `${base}/api/drone/connect`,
      disconnect: `${base}/api/drone/disconnect`,
      video_feed: `${base}/video_feed`,
      socket_io: `${base}`
    }
  });
});

/**
 * POST /api/drone/connect
 * Register or connect a drone to the command center
 */
router.post('/connect', async (req, res) => {
  try {
    const { drone_id, name, stream_url } = req.body;
    if (!drone_id) {
      return res.status(400).json({ error: 'drone_id is required' });
    }

    if (mongoose.connection.readyState !== 1) {
      const fallbackDrone = {
        drone_id,
        name: name || drone_id,
        status: 'Flying',
        is_connected: true,
        is_active: true,
        stream_url: stream_url || '',
        last_seen: new Date(),
        telemetry: {
          status: 'Flying',
          battery_pct: 98,
          altitude_m: 14.5,
          speed_mps: 4.5
        }
      };
      memoryDrones.set(drone_id, fallbackDrone);
      return res.json({ success: true, drone: fallbackDrone, mode: 'memory' });
    }

    // Check if this is the only drone, if so make it active
    const droneCount = await Drone.countDocuments({ is_active: true });
    const shouldBeActive = droneCount === 0;

    const drone = await Drone.findOneAndUpdate(
      { drone_id },
      {
        name: name || drone_id,
        status: 'Idle',
        is_connected: true,
        is_active: shouldBeActive,
        last_seen: new Date()
      },
      { upsert: true, new: true }
    );

    const io = req.app.get('io');
    if (io) {
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
      io.emit('telemetry_update', {
        active_drone: drone.is_active ? drone.drone_id : null,
        all_drones: stats.all_drones,
        telemetry: drone.telemetry
      });
    }

    res.json({ success: true, drone });
  } catch (err) {
    console.error('Error connecting drone:', err);
    res.status(500).json({ error: 'Failed to connect drone' });
  }
});

/**
 * POST /api/drone/disconnect
 * Disconnect a drone
 */
router.post('/disconnect', async (req, res) => {
  try {
    const { drone_id } = req.body;
    if (!drone_id) {
      return res.status(400).json({ error: 'drone_id is required' });
    }

    if (mongoose.connection.readyState !== 1) {
      memoryDrones.delete(drone_id);
      return res.json({ success: true, message: `Drone ${drone_id} disconnected (memory mode)` });
    }

    const drone = await Drone.findOneAndUpdate(
      { drone_id },
      { is_connected: false, status: 'Idle', is_active: false },
      { new: true }
    );

    const io = req.app.get('io');
    if (io) {
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
    }

    res.json({ success: true, message: `Drone ${drone_id} disconnected` });
  } catch (err) {
    console.error('Error disconnecting drone:', err);
    res.status(500).json({ error: 'Failed to disconnect drone' });
  }
});

/**
 * POST /api/drone/telemetry
 * Ingest live telemetry from the connected drone and store in MongoDB
 */
router.post('/telemetry', async (req, res) => {
  try {
    const data = req.body;
    const drone_id = data.drone_id || 'Drone-01';

    if (mongoose.connection.readyState !== 1) {
      const io = req.app.get('io');
      if (io) {
        io.emit('telemetry_update', {
          active_drone: drone_id,
          telemetry: data
        });
      }
      return res.json({ success: true, message: 'Telemetry broadcast (memory mode)' });
    }

    // 1. Save telemetry history snapshot to MongoDB
    const telemetryRecord = new Telemetry({
      drone_id,
      status: data.status || 'Flying',
      battery_pct: data.battery_pct != null ? data.battery_pct : 100,
      battery_voltage: data.battery_voltage || 8.4,
      altitude_m: data.altitude_m || 0.0,
      speed_mps: data.speed_mps || 0.0,
      imu_temp_c: data.imu_temp_c || 25.0,
      gimbal_pitch_deg: data.gimbal_pitch_deg || 0,
      wind_speed_mps: data.wind_speed_mps || 0.0,
      satellites: data.satellites || 0,
      heading_deg: data.heading_deg || 0,
      lat: data.lat || 0.0,
      lng: data.lng || 0.0,
      flight_time_s: data.flight_time_s || 0,
      mission: data.mission || 'Area Scan',
      timestamp: new Date()
    });
    await telemetryRecord.save();

    // 2. Update Drone state in MongoDB
    const drone = await Drone.findOneAndUpdate(
      { drone_id },
      {
        status: data.status || 'Flying',
        battery_pct: data.battery_pct != null ? data.battery_pct : 100,
        is_connected: true,
        last_seen: new Date(),
        telemetry: {
          status: data.status || 'Flying',
          battery_pct: data.battery_pct != null ? data.battery_pct : 100,
          battery_voltage: data.battery_voltage || 8.4,
          altitude_m: data.altitude_m || 0.0,
          speed_mps: data.speed_mps || 0.0,
          imu_temp_c: data.imu_temp_c || 25.0,
          gimbal_pitch_deg: data.gimbal_pitch_deg || 0,
          wind_speed_mps: data.wind_speed_mps || 0.0,
          satellites: data.satellites || 0,
          heading_deg: data.heading_deg || 0,
          lat: data.lat || 0.0,
          lng: data.lng || 0.0,
          flight_time_s: data.flight_time_s || 0,
          mission: data.mission || 'Area Scan'
        }
      },
      { upsert: true, new: true }
    );

    // 3. Broadcast real-time telemetry to all dashboard clients via Socket.IO
    const io = req.app.get('io');
    if (io) {
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
    }

    res.json({ success: true, message: 'Telemetry stored and broadcast' });
  } catch (err) {
    console.error('Error saving telemetry:', err);
    res.status(500).json({ error: 'Failed to record telemetry' });
  }
});

/**
 * POST /api/drone/detection
 * Ingest live waste detection event from drone (or edge YOLO inference) and store in MongoDB
 */
router.post('/detection', async (req, res) => {
  try {
    const { drone_id, class_name, center, timestamp } = req.body;
    if (!class_name) {
      return res.status(400).json({ error: 'class_name is required' });
    }

    // 1. Always save into persistent DetectionStore (prevents data loss when Mongo is offline)
    const detObj = detectionStore.addDetection({
      event_id: req.body.event_id,
      drone_id: drone_id || 'Drone-01',
      class_name,
      material_type: req.body.material_type,
      confidence: req.body.confidence,
      center: center,
      timestamp: timestamp
    });

    let savedToMongo = false;
    // 2. Also persist to MongoDB Atlas if connected
    if (mongoose.connection.readyState === 1) {
      try {
        const detection = new Detection(detObj);
        await detection.save();
        savedToMongo = true;
      } catch (e) {
        console.warn('[MongoDB] Save warning:', e.message);
      }
    }

    // 3. Broadcast real-time detection & stats to connected dashboard clients
    const io = req.app.get('io');
    if (io) {
      io.emit('new_detection', detObj);
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
    }

    res.status(201).json({
      success: true,
      detection: detObj,
      database: savedToMongo ? 'mongodb_atlas' : 'persistent_store'
    });
  } catch (err) {
    console.error('Error saving detection:', err);
    res.status(500).json({ error: 'Failed to store detection event: ' + err.message });
  }
});

/**
 * POST /api/drone/stream-frame
 * Ingest raw camera JPEG frame and stream to /video_feed clients
 */
router.post('/stream-frame', (req, res) => {
  try {
    let frameBuffer;

    if (Buffer.isBuffer(req.body)) {
      frameBuffer = req.body;
    } else if (req.body && req.body.frame) {
      frameBuffer = Buffer.from(req.body.frame.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } else {
      return res.status(400).json({ error: 'Frame buffer or base64 frame required' });
    }

    broadcastFrame(frameBuffer);
    res.json({ success: true });
  } catch (err) {
    console.error('Error streaming frame:', err);
    res.status(500).json({ error: 'Failed to stream frame' });
  }
});

module.exports = router;

