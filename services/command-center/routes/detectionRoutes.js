const express = require('express');
const router = express.Router();
const statsService = require('../db/statsService');

/**
 * @route   GET /api/events
 * @desc    Get detection events list (synchronized with stats & charts)
 */
router.get('/events', async (req, res) => {
  try {
    const events = await statsService.getEvents(100);
    res.json(events);
  } catch (error) {
    console.error('[Get Events Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/events
 * @desc    Save new detection event and broadcast via Socket.io
 */
router.post('/events', async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const { event_id, class_name, confidence, center, drone_id, severity } = req.body;

    const eventId = event_id || `EV-${Math.floor(1000 + Math.random() * 9000)}`;
    const className = class_name || 'Plastic Bottles';
    const conf = confidence != null ? Number(confidence) : 0.88;
    const droneId = drone_id || req.app.get('activeDroneId') || 'Drone-01';
    const locCenter = center || [40.7250, -73.9790];
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

    const newEvent = {
      event_id: eventId,
      class_name: className,
      confidence: conf,
      center: locCenter,
      drone_id: droneId,
      severity: severity || (className === 'Hazardous' ? 'critical' : 'medium'),
      timestamp: timeStr
    };

    await statsService.addDetection(newEvent);

    if (io) {
      io.emit('new_detection', newEvent);
      // Also emit updated stats so cards immediately refresh
      const stats = await statsService.getStatsPayload(droneId);
      io.emit('stats_update', stats);
    }

    res.status(201).json({ success: true, event: newEvent });
  } catch (error) {
    console.error('[Save Detection Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aliases for /api/detections
router.get('/detections', async (req, res) => {
  try {
    const events = await statsService.getEvents(100);
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/detections', async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const { event_id, class_name, confidence, center, drone_id, severity } = req.body;

    const eventId = event_id || `EV-${Date.now().toString().slice(-6)}`;
    const className = class_name || 'Plastic Bottles';
    const conf = confidence != null ? Number(confidence) : 0.90;
    const droneId = drone_id || req.app.get('activeDroneId') || 'Drone-01';
    const locCenter = center || [40.7250, -73.9790];
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

    const newEvent = {
      event_id: eventId,
      class_name: className,
      confidence: conf,
      center: locCenter,
      drone_id: droneId,
      severity: severity || (className === 'Hazardous' ? 'critical' : 'medium'),
      timestamp: timeStr
    };

    await statsService.addDetection(newEvent);

    if (io) {
      io.emit('new_detection', newEvent);
      const stats = await statsService.getStatsPayload(droneId);
      io.emit('stats_update', stats);
    }

    res.status(201).json({ success: true, event: newEvent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/feed/clear
 * @desc    Clear detection feed table
 */
router.post('/feed/clear', async (req, res) => {
  try {
    await statsService.clearDetections();
    res.json({ success: true, message: 'Detection feed cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/stats
 * @desc    Aggregate waste statistics, drone states, and active tracks
 */
router.get('/stats', async (req, res) => {
  try {
    const activeDroneId = req.app.get('activeDroneId') || 'Drone-01';
    const payload = await statsService.getStatsPayload(activeDroneId);
    res.json(payload);
  } catch (error) {
    console.error('[Get Stats Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/chart_data
 * @desc    Aggregate detection categories for Chart.js bar & doughnut charts
 */
router.get('/chart_data', async (req, res) => {
  try {
    const chartData = await statsService.getChartData();
    res.json(chartData);
  } catch (error) {
    console.error('[Get Chart Data Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
