const express = require('express');
const router = express.Router();
const Mission = require('../models/Mission');
const { isDbConnected } = require('../config/db');
const memoryStore = require('../db/memoryStore');

/**
 * @route   GET /api/missions
 * @desc    Get all missions from MongoDB
 */
router.get('/', async (req, res) => {
  try {
    if (isDbConnected()) {
      const missions = await Mission.find().sort({ createdAt: -1 });
      return res.json(missions);
    } else {
      return res.json(memoryStore.getMissions());
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/missions
 * @desc    Save a flight mission with waypoints to MongoDB
 */
router.post('/', async (req, res) => {
  try {
    const { name, mission_id, waypoints, altitude_m, speed_mps, overlap_pct, drone_id } = req.body;

    const mId = mission_id || `MSN-${Math.floor(1000 + Math.random() * 9000)}`;
    const missionName = name || `Survey Mission ${mId}`;

    // Calculate estimates
    const wpList = Array.isArray(waypoints) ? waypoints : [];
    let estDistance = 0;
    for (let i = 1; i < wpList.length; i++) {
      const dLat = (wpList[i].lat - wpList[i - 1].lat) * 111000;
      const dLng = (wpList[i].lng - wpList[i - 1].lng) * 85000;
      estDistance += Math.sqrt(dLat * dLat + dLng * dLng);
    }
    const speed = speed_mps || 8;
    const estDuration = speed > 0 ? Math.round(estDistance / speed) : 0;
    const estBatteryBurn = Math.min(100, Math.round((estDuration / 1800) * 100));

    const missionData = {
      mission_id: mId,
      name: missionName,
      status: 'planned',
      drone_id: drone_id || 'Drone-01',
      altitude_m: altitude_m || 100,
      speed_mps: speed,
      overlap_pct: overlap_pct || 70,
      waypoints: wpList.map((w, idx) => ({
        order: idx + 1,
        lat: w.lat,
        lng: w.lng,
        alt_m: w.alt_m || altitude_m || 100
      })),
      estimated_distance_m: Math.round(estDistance),
      estimated_duration_s: estDuration,
      estimated_battery_burn_pct: estBatteryBurn
    };

    if (isDbConnected()) {
      const mission = await Mission.create(missionData);
      return res.status(201).json({ success: true, mission });
    } else {
      memoryStore.saveMission(missionData);
      return res.status(201).json({ success: true, mission: missionData });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/missions/:id
 * @desc    Get single mission by ID from MongoDB
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isDbConnected()) {
      const mission = await Mission.findOne({
        $or: [{ mission_id: id }, { _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }]
      });
      if (!mission) return res.status(404).json({ error: 'Mission not found' });
      return res.json(mission);
    } else {
      const mission = memoryStore.getMissions().find(m => m.mission_id === id);
      if (!mission) return res.status(404).json({ error: 'Mission not found' });
      return res.json(mission);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
