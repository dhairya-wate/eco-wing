const express = require('express');
const router = express.Router();
const Footage = require('../models/Footage');
const { isDbConnected } = require('../config/db');

// In-memory fallback
let memoryFootage = [];

/**
 * @route   GET /api/footage
 * @desc    Get all drone captured footage records
 */
router.get('/', async (req, res) => {
  try {
    if (isDbConnected()) {
      const records = await Footage.find().sort({ flight_date: -1 });
      return res.json(records);
    }
    return res.json(memoryFootage);
  } catch (err) {
    console.error('[Footage API Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @route   POST /api/footage
 * @desc    Record new footage dataset
 */
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    if (!data.flight_id || !data.site) {
      return res.status(400).json({ error: 'flight_id and site are required' });
    }

    if (isDbConnected()) {
      const record = await Footage.create(data);
      return res.status(201).json(record);
    }
    memoryFootage.unshift(data);
    return res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @route   DELETE /api/footage/:id
 * @desc    Delete a footage record
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isDbConnected()) {
      await Footage.findOneAndDelete({ flight_id: id });
    } else {
      memoryFootage = memoryFootage.filter(f => f.flight_id !== id);
    }
    res.json({ success: true, message: `Footage ${id} deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
