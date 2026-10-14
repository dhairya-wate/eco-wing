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

function getFeedImagePath() {
  const mainPath = path.join(__dirname, '..', 'assets', 'drone-feed.jpg');
  const pubPath = path.join(__dirname, '..', 'public', 'assets', 'drone-feed.jpg');
  if (fs.existsSync(mainPath)) return mainPath;
  if (fs.existsSync(pubPath)) return pubPath;
  return null;
}

// Route to get single live frame
router.get('/video_feed/snapshot', async (req, res) => {
  const feedImg = getFeedImagePath();
  if (feedImg) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.sendFile(feedImg);
  }
  return res.status(404).json({ error: 'No live snapshot available from drone' });
});

// Route for video feed frame
router.get('/video_feed', async (req, res) => {
  const feedImg = getFeedImagePath();
  if (feedImg) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.sendFile(feedImg);
  }
  return res.status(404).json({ error: 'No live video stream available from drone' });
});

module.exports = router;
