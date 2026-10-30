const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Detection = require('../models/Detection');
const Drone = require('../models/Drone');
const Telemetry = require('../models/Telemetry');
const { getStreamStats } = require('../videoStream');
const detectionStore = require('../detectionStore');

// Preset colors for site analysis charts
const CLASS_COLORS = [
  '#4453e0', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6',
  '#06b6d4', '#10b981', '#f97316', '#6366f1', '#14b8a6'
];

/**
 * Helper to compute dashboard stats from MongoDB
 */
async function computeDashboardStats() {
  const streamStats = getStreamStats();
  const fallbackStats = detectionStore.getStats();

  let totalUnique = fallbackStats.total_unique;
  let class_counts = { ...fallbackStats.class_counts };
  let material_counts = { ...fallbackStats.material_counts };
  let activeDroneDoc = null;
  let allDronesList = [];

  if (mongoose.connection.readyState === 1) {
    try {
      const [mTotal, classAgg, materialAgg, aDrone, allDrones] = await Promise.all([
        Detection.countDocuments(),
        Detection.aggregate([
          { $group: { _id: '$class_name', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]),
        Detection.aggregate([
          { $group: { _id: '$material_type', count: { $sum: 1 } } }
        ]),
        Drone.findOne({ is_active: true }),
        Drone.find()
      ]);

      activeDroneDoc = aDrone;
      allDronesList = allDrones || [];

      if (mTotal > 0) {
        totalUnique = mTotal;
        class_counts = {};
        classAgg.forEach(item => {
          class_counts[item._id] = item.count;
        });

        material_counts = { recyclable: 0, biodegradable: 0, non_recyclable: 0 };
        materialAgg.forEach(m => {
          const k = String(m._id || '').toLowerCase();
          if (k.includes('recyclable') && !k.includes('non')) material_counts.recyclable += m.count;
          else if (k.includes('bio')) material_counts.biodegradable += m.count;
          else material_counts.non_recyclable += m.count;
        });
      }
    } catch (e) {
      console.warn('[MongoDB] Query warning in computeDashboardStats:', e.message);
    }
  }

  const all_drones = {};
  allDronesList.forEach(d => {
    all_drones[d.drone_id] = {
      status: d.status || 'Idle',
      battery_pct: d.battery_pct != null ? d.battery_pct : 100
    };
  });

  const isRunning = streamStats.isStreaming || (activeDroneDoc && ['Flying', 'flying'].includes(activeDroneDoc.status));

  return {
    total_unique: totalUnique,
    active_tracks: streamStats.isStreaming ? 1 : 0,
    fps: streamStats.fps,
    running: Boolean(isRunning),
    class_counts: class_counts,
    material_counts: material_counts,
    telemetry: activeDroneDoc ? activeDroneDoc.telemetry : null,
    all_drones: all_drones
  };
}

/**
 * GET /api/stats
 * Dashboard metrics (unique detections, active tracks, FPS, class counts, etc.)
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await computeDashboardStats();
    res.json(stats);
  } catch (err) {
    console.error('Error fetching /api/stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/events
 * Array of detection events (up to last 200, newest first)
 */
router.get('/events', async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      try {
        const docs = await Detection.find()
          .sort({ createdAt: -1 })
          .limit(200);

        if (docs && docs.length > 0) {
          const { inferMaterialType } = require('../models/Detection');
          const events = docs.map(d => ({
            event_id: d.event_id,
            class_name: d.class_name,
            material_type: d.material_type || inferMaterialType(d.class_name),
            confidence: d.confidence,
            center: d.center,
            timestamp: d.timestamp
          }));
          return res.json(events);
        }
      } catch (e) {
        console.warn('[MongoDB] Query warning in /api/events:', e.message);
      }
    }

    // Fallback: persistent store events
    res.json(detectionStore.getEvents(200));
  } catch (err) {
    console.error('Error fetching /api/events:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

/**
 * POST /api/feed/clear
 * Resets detection history in MongoDB
 */
router.post('/feed/clear', async (req, res) => {
  try {
    detectionStore.clear();

    if (mongoose.connection.readyState === 1) {
      try {
        await Detection.deleteMany({});
      } catch (e) {
        console.warn('[MongoDB] Delete warning:', e.message);
      }
    }
    
    // Broadcast cleared stats to all web clients
    const io = req.app.get('io');
    if (io) {
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
    }

    res.json({ success: true, message: 'Detection feed cleared across all database stores' });
  } catch (err) {
    console.error('Error clearing feed:', err);
    res.status(500).json({ error: 'Failed to clear feed' });
  }
});

/**
 * GET /api/chart_data
 * Bar & Doughnut chart data (labels, data counts, colors)
 */
router.get('/chart_data', async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      try {
        const [agg, matAgg] = await Promise.all([
          Detection.aggregate([
            { $group: { _id: '$class_name', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ]),
          Detection.aggregate([
            { $group: { _id: '$material_type', count: { $sum: 1 } } }
          ])
        ]);

        if (agg && agg.length > 0) {
          const labels = agg.map(a => a._id);
          const data = agg.map(a => a.count);
          const colors = labels.map((_, i) => CLASS_COLORS[i % CLASS_COLORS.length]);

          let rec = 0, bio = 0, other = 0;
          matAgg.forEach(m => {
            const k = String(m._id || '').toLowerCase();
            if (k.includes('recyclable') && !k.includes('non')) rec += m.count;
            else if (k.includes('bio')) bio += m.count;
            else other += m.count;
          });

          return res.json({
            labels,
            data,
            colors,
            eco: {
              labels: ['Recyclable', 'Biodegradable', 'Non-Recyclable'],
              data: [rec, bio, other],
              colors: ['#10b981', '#84cc16', '#f59e0b']
            }
          });
        }
      } catch (e) {
        console.warn('[MongoDB] Query warning in /api/chart_data:', e.message);
      }
    }

    // Fallback: chart data calculated from persistent store
    res.json(detectionStore.getChartData());
  } catch (err) {
    console.error('Error fetching /api/chart_data:', err);
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
});

/**
 * GET /api/telemetry
 * Active drone telemetry and fleet status
 */
router.get('/telemetry', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ active_drone: null, all_drones: {}, telemetry: null });
    }
    const drones = await Drone.find();
    let activeDrone = drones.find(d => d.is_active) || (drones.length > 0 ? drones[0] : null);

    const all_drones = {};
    drones.forEach(d => {
      all_drones[d.drone_id] = {
        status: d.status || 'Idle',
        battery_pct: d.battery_pct != null ? d.battery_pct : 100
      };
    });

    res.json({
      active_drone: activeDrone ? activeDrone.drone_id : null,
      all_drones: all_drones,
      telemetry: activeDrone ? activeDrone.telemetry : null
    });
  } catch (err) {
    console.error('Error fetching /api/telemetry:', err);
    res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

/**
 * POST /api/drone/select
 * Select active drone
 */
router.post('/drone/select', async (req, res) => {
  try {
    const { drone_id } = req.body;
    if (!drone_id) {
      return res.status(400).json({ error: 'drone_id is required' });
    }

    await Drone.updateMany({}, { is_active: false });
    const selected = await Drone.findOneAndUpdate(
      { drone_id },
      { is_active: true },
      { new: true }
    );

    const io = req.app.get('io');
    if (io) {
      const drones = await Drone.find();
      const all_drones = {};
      drones.forEach(d => {
        all_drones[d.drone_id] = {
          status: d.status || 'Idle',
          battery_pct: d.battery_pct != null ? d.battery_pct : 100
        };
      });

      io.emit('telemetry_update', {
        active_drone: drone_id,
        all_drones: all_drones,
        telemetry: selected ? selected.telemetry : null
      });
    }

    res.json({ success: true, active_drone: drone_id });
  } catch (err) {
    console.error('Error in /api/drone/select:', err);
    res.status(500).json({ error: 'Failed to select drone' });
  }
});

/**
 * POST /api/drone/command
 * Send commands to drone (start, hold, rth, land)
 */
router.post('/drone/command', async (req, res) => {
  try {
    const { command, drone_id } = req.body;
    if (!command || !drone_id) {
      return res.status(400).json({ error: 'command and drone_id are required' });
    }

    const commandStatusMap = {
      start: 'Flying',
      hold: 'Holding',
      rth: 'Returning',
      land: 'Landing'
    };

    const newStatus = commandStatusMap[command.toLowerCase()] || command;

    const drone = await Drone.findOneAndUpdate(
      { drone_id },
      { 
        status: newStatus,
        'telemetry.status': newStatus
      },
      { new: true }
    );

    const io = req.app.get('io');
    if (io) {
      // Forward command to drone and notify web clients
      io.emit('drone_command_executed', { command, drone_id });
      io.to(`drone:${drone_id}`).emit('command', { command });

      // Update telemetry
      const drones = await Drone.find();
      const all_drones = {};
      drones.forEach(d => {
        all_drones[d.drone_id] = {
          status: d.status,
          battery_pct: d.battery_pct != null ? d.battery_pct : 100
        };
      });

      io.emit('telemetry_update', {
        active_drone: drone_id,
        all_drones: all_drones,
        telemetry: drone ? drone.telemetry : null
      });
    }

    res.json({ message: `${drone_id} received command: ${command.toUpperCase()}` });
  } catch (err) {
    console.error('Error in /api/drone/command:', err);
    res.status(500).json({ error: 'Failed to execute command' });
  }
});

/**
 * POST /api/camera/command
 * Camera control (photo, record, zoom, track)
 */
router.post('/camera/command', async (req, res) => {
  try {
    const { command, value } = req.body;
    const io = req.app.get('io');

    if (io) {
      if (command === 'record') {
        io.emit('camera_update', { recording: Boolean(value) });
      }
      io.emit('camera_command', { command, value });
    }

    res.json({ message: `Camera command executed: ${command}` });
  } catch (err) {
    console.error('Error in /api/camera/command:', err);
    res.status(500).json({ error: 'Failed to execute camera command' });
  }
});

/**
 * GET /api/export/csv
 * Export detections as CSV file download
 */
router.get('/export/csv', async (req, res) => {
  try {
    const docs = await Detection.find().sort({ createdAt: -1 });
    
    let csv = 'Event ID,Class Name,Confidence,Center X,Center Y,Timestamp,Drone ID\n';
    docs.forEach(d => {
      const cx = Array.isArray(d.center) ? d.center[0] : '';
      const cy = Array.isArray(d.center) ? d.center[1] : '';
      csv += `"${d.event_id}","${d.class_name}",${d.confidence},${cx},${cy},"${d.timestamp}","${d.drone_id || ''}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="ecowing_detections.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Error in /api/export/csv:', err);
    res.status(500).send('Error generating CSV export');
  }
});

/**
 * GET /api/export/json
 * Export detections as JSON file download
 */
router.get('/export/json', async (req, res) => {
  try {
    const docs = await Detection.find().sort({ createdAt: -1 });
    const data = docs.map(d => ({
      event_id: d.event_id,
      class_name: d.class_name,
      confidence: d.confidence,
      center: d.center,
      timestamp: d.timestamp,
      drone_id: d.drone_id
    }));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="ecowing_detections.json"');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error in /api/export/json:', err);
    res.status(500).send('Error generating JSON export');
  }
});

module.exports = {
  router,
  computeDashboardStats
};

