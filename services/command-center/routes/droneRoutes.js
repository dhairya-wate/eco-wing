const express = require('express');
const router = express.Router();
const Drone = require('../models/Drone');
const { isDbConnected } = require('../config/db');
const memoryStore = require('../db/memoryStore');

/**
 * @route   GET /api/drones
 * @desc    Get all drones in fleet
 */
router.get('/', async (req, res) => {
  try {
    if (isDbConnected()) {
      const drones = await Drone.find().sort({ drone_id: 1 });
      return res.json(drones);
    } else {
      return res.json(memoryStore.getDrones());
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/drones
 * @desc    Register a new drone in MongoDB fleet
 */
router.post('/', async (req, res) => {
  try {
    const { drone_id, name, model, current_mission } = req.body;
    if (!drone_id || !name) {
      return res.status(400).json({ success: false, message: 'drone_id and name are required' });
    }

    const cleanId = drone_id.trim();

    let createdDrone = null;
    if (isDbConnected()) {
      const existing = await Drone.findOne({ drone_id: cleanId });
      if (existing) {
        return res.status(400).json({ success: false, message: 'Drone with this ID already exists' });
      }

      createdDrone = await Drone.create({
        drone_id: cleanId,
        name: name.trim(),
        model: model || 'EcoWing Falcon Quad-RTK',
        status: 'idle',
        battery_pct: 100,
        current_mission: current_mission || 'No mission assigned'
      });
    } else {
      createdDrone = {
        drone_id: cleanId,
        name: name.trim(),
        model: model || 'EcoWing Falcon Quad-RTK',
        status: 'idle',
        battery_pct: 100,
        current_mission: current_mission || 'No mission assigned'
      };
      memoryStore.saveDrone(createdDrone);
    }

    req.app.set('activeDroneId', cleanId);

    const io = req.app.get('socketio');
    if (io) {
      try {
        const statsService = require('../db/statsService');
        const stats = await statsService.getStatsPayload(cleanId);
        io.emit('stats_update', stats);
      } catch (e) {}
    }

    return res.status(201).json({ success: true, drone: createdDrone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/drone/select
 * @desc    Select active drone in command center
 */
router.post('/select', async (req, res) => {
  try {
    const { drone_id } = req.body;
    if (!drone_id) {
      return res.status(400).json({ success: false, message: 'drone_id is required' });
    }

    req.app.set('activeDroneId', drone_id);
    console.log(`[Fleet] Active drone switched to: ${drone_id}`);

    res.json({ success: true, active_drone: drone_id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/drone/command
 * @desc    Execute flight command on drone (start, hold, rth, land, etc.) and save to MongoDB
 */
router.post('/command', async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const { command, drone_id } = req.body;
    const targetDroneId = drone_id || req.app.get('activeDroneId') || 'Drone-01';

    console.log(`[Drone Command] Executing '${command}' on ${targetDroneId}`);

    // Map command to drone status
    let newStatus = 'survey';
    if (command === 'start') newStatus = 'survey';
    else if (command === 'hold') newStatus = 'idle';
    else if (command === 'rth') newStatus = 'rth';
    else if (command === 'land') newStatus = 'landed';

    if (isDbConnected()) {
      await Drone.findOneAndUpdate(
        { drone_id: targetDroneId },
        { status: newStatus, last_telemetry_at: new Date() },
        { upsert: true }
      );
    } else {
      const d = memoryStore.getDrone(targetDroneId) || { drone_id: targetDroneId };
      d.status = newStatus;
      memoryStore.saveDrone(d);
    }

    const payload = {
      command: command,
      drone_id: targetDroneId,
      status: newStatus,
      timestamp: new Date().toISOString()
    };

    if (io) {
      io.emit('drone_command_executed', payload);
    }

    res.json({ success: true, result: payload });
  } catch (error) {
    console.error('[Drone Command Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   DELETE /api/drones/:id
 * @desc    Remove a drone from MongoDB fleet
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isDbConnected()) {
      await Drone.findOneAndDelete({ drone_id: id });
    }
    if (memoryStore.deleteDrone) {
      memoryStore.deleteDrone(id);
    }
    if (req.app.get('activeDroneId') === id) {
      let remainingId = null;
      if (isDbConnected()) {
        const remaining = await Drone.find().sort({ drone_id: 1 });
        if (remaining.length > 0) remainingId = remaining[0].drone_id;
      } else {
        const remaining = memoryStore.getDrones();
        if (remaining.length > 0) remainingId = remaining[0].drone_id;
      }
      req.app.set('activeDroneId', remainingId);
    }
    console.log(`[Fleet] Drone ${id} removed from fleet`);

    const io = req.app.get('socketio');
    if (io) {
      try {
        const statsService = require('../db/statsService');
        const stats = await statsService.getStatsPayload();
        io.emit('stats_update', stats);
      } catch (e) {}
    }

    res.json({ success: true, message: `Drone ${id} removed from fleet` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
