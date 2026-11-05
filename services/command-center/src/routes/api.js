const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Detection = require('../models/Detection');
const SiteAnalysis = require('../models/SiteAnalysis');
const { inferMaterialType, inferDualAxisClassification } = require('../models/Detection');
const Drone = require('../models/Drone');
const Telemetry = require('../models/Telemetry');
const { getStreamStats } = require('../videoStream');
const detectionStore = require('../detectionStore');
const { verifyOperatorToken } = require('../middleware/auth');
const { commandManager } = require('../services/commandManager');
const deviceRouter = require('./devices');

router.use(deviceRouter);

// E1: Whitelist definitions and identifier constraints
const ALLOWED_DRONE_COMMANDS = ['start', 'hold', 'rth', 'land'];
const ALLOWED_CAMERA_COMMANDS = ['photo', 'record', 'zoom', 'track'];
const DRONE_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

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

  let recyclableCount = 0;
  let nonRecyclableCount = 0;
  let biodegradableCount = 0;
  let nonBiodegradableCount = 0;
  Object.entries(class_counts).forEach(([cname, count]) => {
    const eco = inferDualAxisClassification(cname);
    if (eco.is_recyclable) recyclableCount += count;
    else nonRecyclableCount += count;
    if (eco.is_biodegradable) biodegradableCount += count;
    else nonBiodegradableCount += count;
  });

  const tot = totalUnique || 1;
  const recyclablePct = Number(((recyclableCount / tot) * 100).toFixed(1));
  const biodegradablePct = Number(((biodegradableCount / tot) * 100).toFixed(1));

  return {
    total_unique: totalUnique,
    active_tracks: streamStats.isStreaming ? 1 : 0,
    fps: streamStats.fps,
    running: Boolean(isRunning),
    class_counts: class_counts,
    material_counts: material_counts,
    recyclable_count: recyclableCount,
    non_recyclable_count: nonRecyclableCount,
    biodegradable_count: biodegradableCount,
    non_biodegradable_count: nonBiodegradableCount,
    recyclable_percentage: recyclablePct,
    biodegradable_percentage: biodegradablePct,
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
          const events = docs.map(d => {
            const eco = inferDualAxisClassification(d.class_name, d);
            return {
              event_id: d.event_id,
              canonical_event_id: d.canonical_event_id,
              drone_id: d.drone_id,
              class_name: d.class_name,
              material_type: d.material_type || eco.material_type,
              is_recyclable: d.is_recyclable !== undefined ? d.is_recyclable : eco.is_recyclable,
              is_biodegradable: d.is_biodegradable !== undefined ? d.is_biodegradable : eco.is_biodegradable,
              recyclable: d.recyclable || eco.recyclable,
              biodegradable: d.biodegradable || eco.biodegradable,
              disposal_bin: d.disposal_bin || eco.disposal_bin,
              confidence: d.confidence,
              center: d.center,
              timestamp: d.timestamp
            };
          });
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
 * GET /api/analysis
 * Comprehensive dual-axis site analysis: Recyclable (yes/no) & Biodegradable (yes/no)
 */
router.get('/analysis', async (req, res) => {
  try {
    const stats = await computeDashboardStats();
    const classBreakdown = Object.entries(stats.class_counts).map(([name, count]) => {
      const eco = inferDualAxisClassification(name);
      const total = stats.total_unique || 1;
      return {
        name,
        count,
        percentage: Number(((count / total) * 100).toFixed(1)),
        is_recyclable: eco.is_recyclable,
        is_biodegradable: eco.is_biodegradable,
        recyclable: eco.recyclable,
        biodegradable: eco.biodegradable,
        material_type: eco.material_type,
        disposal_bin: eco.disposal_bin
      };
    }).sort((a, b) => b.count - a.count);

    const payload = {
      total_detections: stats.total_unique,
      recyclable_count: stats.recyclable_count,
      non_recyclable_count: stats.non_recyclable_count,
      biodegradable_count: stats.biodegradable_count,
      non_biodegradable_count: stats.non_biodegradable_count,
      recyclable_percentage: stats.recyclable_percentage,
      biodegradable_percentage: stats.biodegradable_percentage,
      classes: classBreakdown,
      database_connected: mongoose.connection.readyState === 1,
      timestamp: new Date().toISOString()
    };

    res.json(payload);
  } catch (err) {
    console.error('Error fetching /api/analysis:', err);
    res.status(500).json({ error: 'Failed to generate site analysis' });
  }
});

/**
 * POST /api/analysis/save
 * Explicitly store current site analysis report snapshot in MongoDB Atlas
 */
router.post('/analysis/save', async (req, res) => {
  try {
    const stats = await computeDashboardStats();
    const classBreakdown = Object.entries(stats.class_counts).map(([name, count]) => {
      const eco = inferDualAxisClassification(name);
      return {
        name,
        count,
        is_recyclable: eco.is_recyclable,
        is_biodegradable: eco.is_biodegradable,
        category: eco.material_type,
        disposal_bin: eco.disposal_bin
      };
    });

    const docData = {
      total_detections: stats.total_unique,
      recyclable_count: stats.recyclable_count,
      non_recyclable_count: stats.non_recyclable_count,
      biodegradable_count: stats.biodegradable_count,
      non_biodegradable_count: stats.non_biodegradable_count,
      recyclable_percentage: stats.recyclable_percentage,
      biodegradable_percentage: stats.biodegradable_percentage,
      classes: classBreakdown,
      source: req.body?.source || 'ecowing_command_center',
      timestamp: new Date()
    };

    let savedId = null;
    let dbStatus = 'persistent_store_only';

    if (mongoose.connection.readyState === 1) {
      try {
        const savedDoc = await SiteAnalysis.create(docData);
        savedId = savedDoc._id;
        dbStatus = 'mongodb_atlas_saved';
      } catch (dbErr) {
        console.warn('Could not save to SiteAnalysis collection:', dbErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Site analysis snapshot successfully stored',
      database_status: dbStatus,
      record_id: savedId,
      data: docData
    });
  } catch (err) {
    console.error('Error in /api/analysis/save:', err);
    res.status(500).json({ error: 'Failed to store site analysis' });
  }
});

/**
 * GET /api/detections
 * Returns real-time detections format expected by dashboard polling
 */
router.get('/detections', async (req, res) => {
  try {
    // If local detection system (port 5000) is running, proxy from it
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);
      const detectionSysUrl = process.env.DETECTION_SYS_URL || 'http://127.0.0.1:5000/api/detections';
      const proxyRes = await fetch(detectionSysUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (proxyRes.ok) {
        const json = await proxyRes.json();
        return res.json(json);
      }
    } catch (e) {}

    // Fallback: build live detections response from detectionStore
    const stats = detectionStore.getStats();
    const recentEvents = detectionStore.getEvents(5);
    const latestItems = recentEvents.map(e => ({
      class_id: (e.class_name || 'waste').toLowerCase().replace(/\s+/g, '_'),
      coco_label: e.class_name,
      confidence: e.confidence || 0.9,
      bbox: [100, 100, 200, 200],
      category: e.class_name,
      material: e.material_type || 'Recyclable',
      recyclable: String(e.material_type || '').toLowerCase().includes('recyclable') && !String(e.material_type || '').toLowerCase().includes('non'),
      biodegradable: String(e.material_type || '').toLowerCase().includes('bio')
    }));

    return res.json({
      status: 'success',
      scope: 'live_frame',
      timestamp: Date.now() / 1000,
      timestamp_iso: new Date().toISOString(),
      age_seconds: 0.1,
      stale: false,
      phone_connected: false,
      data: {
        item_count: latestItems.length,
        items: latestItems,
        waste_classified: latestItems.length > 0,
        recyclable: latestItems.some(i => i.recyclable),
        biodegradable: latestItems.some(i => i.biodegradable),
        timestamp: Date.now() / 1000
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * POST /api/feed/clear
 * Resets detection history in MongoDB
 */
router.post('/feed/clear', verifyOperatorToken, async (req, res) => {
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
router.post('/drone/select', verifyOperatorToken, async (req, res) => {
  try {
    const { drone_id } = req.body;
    if (!drone_id || typeof drone_id !== 'string' || !DRONE_ID_REGEX.test(drone_id) || drone_id.length > 64) {
      return res.status(400).json({ error: 'Invalid drone_id. Must be alphanumeric with hyphens/underscores (max 64 chars).' });
    }

    if (mongoose.connection.readyState !== 1) {
      const io = req.app.get('io');
      if (io) {
        io.emit('telemetry_update', {
          active_drone: drone_id,
          all_drones: { [drone_id]: { status: 'Idle', battery_pct: 100 } },
          telemetry: null
        });
      }
      return res.json({ success: true, active_drone: drone_id, mode: 'memory' });
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
 * Send commands to drone (flight commands) or phone (streaming controls)
 * Target: 'drone' (default) or 'phone'
 */
router.post('/drone/command', verifyOperatorToken, async (req, res) => {
  try {
    const { command, drone_id, device_id, target = 'drone', params, actor, command_id, ack_timeout_seconds } = req.body;
    const targetId = drone_id || device_id;
    if (!targetId || typeof targetId !== 'string' || !DRONE_ID_REGEX.test(targetId) || targetId.length > 64) {
      return res.status(400).json({ error: 'Invalid drone_id. Must be alphanumeric with hyphens/underscores (max 64 chars).' });
    }

    const cleanTarget = String(target || 'drone').trim().toLowerCase();
    if (!['drone', 'phone'].includes(cleanTarget)) {
      return res.status(400).json({ error: "Invalid target. Allowed targets: 'drone', 'phone'." });
    }

    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: "Missing required 'command'." });
    }

    const cleanCommand = command.trim().toLowerCase();

    // Flight command validation for drone target
    if (cleanTarget === 'drone') {
      if (!ALLOWED_DRONE_COMMANDS.includes(cleanCommand)) {
        return res.status(400).json({ error: "Invalid drone command. Allowed commands: 'start', 'hold', 'rth', 'land'." });
      }

      // Physical Drone Safety: Stale Telemetry Guard (E9)
      const freshness = commandManager.checkTelemetryFreshness(targetId, 10.0);
      if (!freshness.fresh && !freshness.missing) {
        return res.status(409).json({
          error: freshness.error,
          age_seconds: freshness.age_seconds
        });
      }
      if (req.headers['x-enforce-telemetry'] === 'true' && freshness.missing) {
        return res.status(409).json({ error: freshness.error, missing: true });
      }
    }

    // Formally initialize command lifecycle in state 'requested' and validate UUIDv4
    let cmd;
    try {
      cmd = commandManager.createCommand({
        drone_id: targetId,
        target: cleanTarget,
        command: cleanCommand,
        params,
        actor: actor || 'operator_console',
        command_id
      });
    } catch (cmdErr) {
      return res.status(400).json({ error: cmdErr.message });
    }

    // Transition state from 'requested' -> 'sent'
    commandManager.transitionCommand(cmd.command_id, 'sent', `Dispatched to ${cleanTarget} command channel`);

    // Arm ACK timeout (default 5.0s)
    const ackTimeoutSec = Number(ack_timeout_seconds) || 5.0;
    commandManager.armAckTimeout(cmd.command_id, ackTimeoutSec, (timedOutCmd) => {
      const io = req.app.get('io');
      if (io) {
        io.emit('command_timed_out', {
          command_id: timedOutCmd.command_id,
          drone_id: targetId,
          target: cleanTarget,
          reason: timedOutCmd.error_message
        });
      }
    });

    const io = req.app.get('io');

    // Phone target handling
    if (cleanTarget === 'phone') {
      if (io) {
        io.emit('phone_command_dispatched', {
          command: cmd.command,
          device_id: targetId,
          params: cmd.params,
          command_id: cmd.command_id
        });
        io.to(`phone:${targetId}`).emit('phone_command', {
          command: cmd.command,
          params: cmd.params,
          command_id: cmd.command_id
        });
      }
      return res.json({
        success: true,
        message: `PHONE received command: ${cleanCommand.toUpperCase()}`,
        command_id: cmd.command_id,
        state: cmd.state,
        command: cmd
      });
    }

    // Drone target handling
    const commandStatusMap = {
      start: 'Flying',
      hold: 'Holding',
      rth: 'Returning',
      land: 'Landing'
    };

    const newStatus = commandStatusMap[cleanCommand];

    if (mongoose.connection.readyState !== 1) {
      if (io) {
        io.emit('drone_command_executed', { command: cleanCommand, drone_id: targetId, command_id: cmd.command_id });
        io.to(`drone:${targetId}`).emit('command', { command: cleanCommand, command_id: cmd.command_id });
      }
      return res.json({
        message: `${targetId} received command: ${cleanCommand.toUpperCase()}`,
        command_id: cmd.command_id,
        state: cmd.state,
        command: cmd,
        mode: 'memory'
      });
    }

    const drone = await Drone.findOneAndUpdate(
      { drone_id: targetId },
      { 
        status: newStatus,
        'telemetry.status': newStatus
      },
      { new: true }
    );

    if (io) {
      // Forward command to drone and notify web clients
      io.emit('drone_command_executed', { command: cleanCommand, drone_id: targetId, command_id: cmd.command_id });
      io.to(`drone:${targetId}`).emit('command', { command: cleanCommand, command_id: cmd.command_id });

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
        active_drone: targetId,
        all_drones: all_drones,
        telemetry: drone ? drone.telemetry : null
      });
    }

    res.json({
      message: `${targetId} received command: ${cleanCommand.toUpperCase()}`,
      command_id: cmd.command_id,
      state: cmd.state,
      command: cmd
    });
  } catch (err) {
    console.error('Error in /api/drone/command:', err);
    res.status(500).json({ error: 'Failed to execute command' });
  }
});

/**
 * POST /api/drone/command/:id/state
 * Transition command state according to canonical state machine (contracts/command.schema.json)
 */
router.post('/drone/command/:id/state', verifyOperatorToken, (req, res) => {
  const commandId = req.params.id;
  const { state, reason } = req.body;
  if (!state || typeof state !== 'string') {
    return res.status(400).json({ error: "Missing required 'state' in body." });
  }

  const result = commandManager.transitionCommand(commandId, state.trim().toLowerCase(), reason);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const io = req.app.get('io');
  if (io) {
    io.emit('command_state_changed', { command_id: commandId, state: result.command.state });
  }

  res.json({ success: true, command: result.command });
});

/**
 * GET /api/drone/command/:id
 * Retrieve command status and audit history
 */
router.get('/drone/command/:id', verifyOperatorToken, (req, res) => {
  const cmd = commandManager.getCommand(req.params.id);
  if (!cmd) {
    return res.status(404).json({ error: `Command '${req.params.id}' not found.` });
  }
  res.json({ success: true, command: cmd });
});

/**
 * POST /api/camera/command
 * Camera control (photo, record, zoom, track)
 */
router.post('/camera/command', verifyOperatorToken, async (req, res) => {
  try {
    const { command, value } = req.body;
    if (!command || typeof command !== 'string' || !ALLOWED_CAMERA_COMMANDS.includes(command.trim().toLowerCase())) {
      return res.status(400).json({ error: "Invalid camera command. Allowed commands: 'photo', 'record', 'zoom', 'track'." });
    }

    const cleanCommand = command.trim().toLowerCase();
    let sanitizedValue = value;

    if (cleanCommand === 'record') {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
        return res.status(400).json({ error: "Parameter 'value' for 'record' must be boolean." });
      }
      sanitizedValue = (value === true || value === 'true');
    } else if (cleanCommand === 'zoom') {
      const zoomNum = Number(value);
      if (isNaN(zoomNum) || zoomNum < 1.0 || zoomNum > 10.0) {
        return res.status(400).json({ error: "Parameter 'value' for 'zoom' must be a number between 1.0 and 10.0." });
      }
      sanitizedValue = zoomNum;
    } else if (cleanCommand === 'track') {
      if (typeof value === 'string' && value && !DRONE_ID_REGEX.test(value)) {
        return res.status(400).json({ error: "Parameter 'value' for 'track' must be an alphanumeric target identifier." });
      }
    }

    const io = req.app.get('io');

    if (io) {
      if (cleanCommand === 'record') {
        io.emit('camera_update', { recording: Boolean(sanitizedValue) });
      }
      io.emit('camera_command', { command: cleanCommand, value: sanitizedValue });
    }

    res.json({ message: `Camera command executed: ${cleanCommand}` });
  } catch (err) {
    console.error('Error in /api/camera/command:', err);
    res.status(500).json({ error: 'Failed to execute camera command' });
  }
});

/**
 * GET /api/export/csv
 * Export detections as CSV file download
 */
router.get('/export/csv', verifyOperatorToken, async (req, res) => {
  try {
    let docs = [];
    if (mongoose.connection.readyState === 1) {
      try {
        docs = await Detection.find().sort({ createdAt: -1 });
      } catch (e) {
        docs = detectionStore.getEvents(200);
      }
    } else {
      docs = detectionStore.getEvents(200);
    }
    
    let csv = 'Event ID,Class Name,Recyclable,Biodegradable,Disposal Bin,Confidence,Center X,Center Y,Timestamp,Drone ID\n';
    docs.forEach(d => {
      const cx = Array.isArray(d.center) ? d.center[0] : '';
      const cy = Array.isArray(d.center) ? d.center[1] : '';
      const eco = inferDualAxisClassification(d.class_name, d);
      const rec = d.recyclable || eco.recyclable;
      const bio = d.biodegradable || eco.biodegradable;
      const bin = d.disposal_bin || eco.disposal_bin;
      csv += `"${d.event_id}","${d.class_name}","${rec}","${bio}","${bin}",${d.confidence},${cx},${cy},"${d.timestamp}","${d.drone_id || ''}"\n`;
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
router.get('/export/json', verifyOperatorToken, async (req, res) => {
  try {
    let docs = [];
    if (mongoose.connection.readyState === 1) {
      try {
        docs = await Detection.find().sort({ createdAt: -1 });
      } catch (e) {
        docs = detectionStore.getEvents(200);
      }
    } else {
      docs = detectionStore.getEvents(200);
    }
    const data = docs.map(d => {
      const eco = inferDualAxisClassification(d.class_name, d);
      return {
        event_id: d.event_id,
        class_name: d.class_name,
        is_recyclable: d.is_recyclable !== undefined ? d.is_recyclable : eco.is_recyclable,
        is_biodegradable: d.is_biodegradable !== undefined ? d.is_biodegradable : eco.is_biodegradable,
        recyclable: d.recyclable || eco.recyclable,
        biodegradable: d.biodegradable || eco.biodegradable,
        disposal_bin: d.disposal_bin || eco.disposal_bin,
        confidence: d.confidence,
        center: d.center,
        timestamp: d.timestamp,
        drone_id: d.drone_id
      };
    });

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

