const express = require('express');
const router = express.Router();
const Drone = require('../models/Drone');
const TelemetryLog = require('../models/TelemetryLog');
const { isDbConnected } = require('../config/db');
const memoryStore = require('../db/memoryStore');

/**
 * @route   GET /api/telemetry
 * @desc    Get telemetry data for active drone & sensor table
 */
router.get('/', async (req, res) => {
  try {
    const activeDroneId = req.app.get('activeDroneId') || null;
    let allDrones = {};
    let drone = null;
    if (isDbConnected()) {
      const droneDocs = await Drone.find().sort({ drone_id: 1 });
      droneDocs.forEach(d => {
        allDrones[d.drone_id] = {
          name: d.name,
          status: d.status ? (d.status.charAt(0).toUpperCase() + d.status.slice(1)) : 'Idle',
          battery_pct: d.battery_pct != null ? d.battery_pct : 100,
          mission: d.current_mission || 'Ready for sortie'
        };
      });
      if (activeDroneId) {
        drone = await Drone.findOne({ drone_id: activeDroneId });
      }
      if (!drone && droneDocs.length > 0) {
        drone = droneDocs[0];
      }
    } else {
      const droneDocs = memoryStore.getDrones();
      droneDocs.forEach(d => {
        allDrones[d.drone_id] = {
          name: d.name,
          status: d.status ? (d.status.charAt(0).toUpperCase() + d.status.slice(1)) : 'Idle',
          battery_pct: d.battery_pct != null ? d.battery_pct : 100,
          mission: d.current_mission || 'Ready for sortie'
        };
      });
      if (activeDroneId) {
        drone = memoryStore.getDrone(activeDroneId);
      }
      if (!drone && droneDocs.length > 0) {
        drone = droneDocs[0];
      }
    }

    const t = drone?.telemetry || {};
    const payload = {
      active_drone: drone?.drone_id || null,
      all_drones: allDrones,
      telemetry: drone ? {
        lat: t.lat || 40.7250,
        lng: t.lng || -73.9790,
        altitude_m: t.altitude_m || 85.0,
        speed_mps: t.speed_mps || 6.4,
        heading_deg: t.heading_deg || 142,
        battery_pct: drone.battery_pct != null ? drone.battery_pct : 100,
        battery_voltage: drone.battery_voltage || 24.8,
        satellites: t.satellites || 18,
        imu_temp_c: t.imu_temp_c || 34.5,
        wind_speed_mps: t.wind_speed_mps || 5.2,
        gimbal_pitch_deg: drone?.camera?.tilt_deg || -45,
        flight_time_s: drone?.flight_time_s || 0,
        status: drone?.status === 'idle' ? 'Idle' : (drone?.status || 'Active')
      } : null
    };

    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/telemetry
 * @desc    Ingest telemetry packet from drone into MongoDB
 */
router.post('/', async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const { drone_id, telemetry } = req.body;
    const targetDroneId = drone_id || 'Drone-01';

    if (isDbConnected() && telemetry) {
      await Drone.findOneAndUpdate(
        { drone_id: targetDroneId },
        {
          telemetry: telemetry,
          battery_pct: telemetry.battery_pct,
          battery_voltage: telemetry.battery_voltage,
          last_telemetry_at: new Date()
        }
      );

      // Log historical point
      await TelemetryLog.create({
        drone_id: targetDroneId,
        lat: telemetry.lat,
        lng: telemetry.lng,
        altitude_m: telemetry.altitude_m,
        speed_mps: telemetry.speed_mps,
        heading_deg: telemetry.heading_deg,
        battery_pct: telemetry.battery_pct,
        battery_voltage: telemetry.battery_voltage,
        satellites: telemetry.satellites,
        imu_temp_c: telemetry.imu_temp_c,
        wind_speed_mps: telemetry.wind_speed_mps
      }).catch(() => {});
    }

    if (io) {
      io.emit('telemetry_update', { drone_id: targetDroneId, telemetry });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
