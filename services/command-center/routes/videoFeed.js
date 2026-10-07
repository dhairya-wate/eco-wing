const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const Drone = require('../models/Drone');
const memoryStore = require('../db/memoryStore');
const { isDbConnected } = require('../config/db');

async function hasActiveDrone(req) {
  const activeId = req.app.get('activeDroneId');
  if (activeId) return true;
  if (isDbConnected()) {
    try {
      const count = await Drone.countDocuments();
      return count > 0;
    } catch (_) {}
  }
  const memDrones = memoryStore.getDrones();
  return memDrones.length > 0;
}

// Route to get single live frame
router.get('/video_feed/snapshot', async (req, res) => {
  return res.status(404).json({ error: 'No live snapshot available from drone' });
});

// Route for video feed frame
router.get('/video_feed', async (req, res) => {
  return res.status(404).json({ error: 'No live video stream available from drone' });
});

module.exports = router;
