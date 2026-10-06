const express = require('express');
const router = express.Router();
const Detection = require('../models/Detection');
const { isDbConnected } = require('../config/db');
const memoryStore = require('../db/memoryStore');

/**
 * @route   GET /api/export/csv
 * @desc    Export detections from MongoDB as a CSV file
 */
router.get('/csv', async (req, res) => {
  try {
    let records = [];

    if (isDbConnected()) {
      records = await Detection.find().sort({ createdAt: -1 }).limit(1000);
    } else {
      records = memoryStore.getDetections(1000);
    }

    const headers = ['Event ID', 'Class Name', 'Confidence (%)', 'Latitude', 'Longitude', 'Drone ID', 'Severity', 'Timestamp', 'Status'];
    const rows = records.map(r => {
      const conf = Math.round((r.confidence || 0) * 100);
      const lat = r.center ? r.center[0] : (r.location?.coordinates?.[1] || 40.7250);
      const lng = r.center ? r.center[1] : (r.location?.coordinates?.[0] || -73.9790);
      return [
        `"${r.event_id || ''}"`,
        `"${r.class_name || ''}"`,
        conf,
        lat,
        lng,
        `"${r.drone_id || 'Drone-01'}"`,
        `"${r.severity || 'medium'}"`,
        `"${r.timestamp || ''}"`,
        `"${r.status || 'detected'}"`
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ecowing_detections_${Date.now()}.csv"`);
    res.status(200).send(csvContent);
  } catch (error) {
    console.error('[Export CSV Error]:', error);
    res.status(500).send('Error generating CSV export');
  }
});

/**
 * @route   GET /api/export/json
 * @desc    Export detections from MongoDB as a JSON file
 */
router.get('/json', async (req, res) => {
  try {
    let records = [];

    if (isDbConnected()) {
      records = await Detection.find().sort({ createdAt: -1 }).limit(1000);
    } else {
      records = memoryStore.getDetections(1000);
    }

    const jsonContent = JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        total_records: records.length,
        source: isDbConnected() ? 'MongoDB' : 'MemoryCache',
        detections: records
      },
      null,
      2
    );

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="ecowing_detections_${Date.now()}.json"`);
    res.status(200).send(jsonContent);
  } catch (error) {
    console.error('[Export JSON Error]:', error);
    res.status(500).json({ error: 'Error generating JSON export' });
  }
});

module.exports = router;
