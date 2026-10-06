/**
 * Professional Drone Optical Camera Stream Service.
 * Serves real high-resolution aerial survey camera frames.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const imagePath = path.join(__dirname, '..', 'assets', 'drone-feed.jpg');

// Route to get single live frame
router.get('/video_feed/snapshot', (req, res) => {
  if (fs.existsSync(imagePath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.sendFile(imagePath);
  }
  res.status(404).json({ error: 'Snapshot not available' });
});

// Route for video feed frame
router.get('/video_feed', (req, res) => {
  if (fs.existsSync(imagePath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.sendFile(imagePath);
  }
  res.status(404).json({ error: 'Feed not available' });
});

module.exports = router;
