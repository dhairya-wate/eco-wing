const express = require('express');
const router = express.Router();
const Drone = require('../models/Drone');
const { isDbConnected } = require('../config/db');

// In-memory state for camera
let cameraState = {
  recording: false,
  zoom: 1.0,
  tilt_deg: -45,
  last_snap: null
};

/**
 * @route   POST /api/camera/command
 * @desc    Execute camera command (snap, start_rec, stop_rec, zoom, tilt)
 */
router.post('/command', async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const { command, zoom, tilt, drone_id } = req.body;
    const targetDroneId = drone_id || req.app.get('activeDroneId') || 'Drone-01';

    if (command === 'snap') {
      cameraState.last_snap = new Date().toISOString();
      console.log(`[Camera] Snapshot taken on ${targetDroneId}`);
    } else if (command === 'start_rec' || command === 'startRec') {
      cameraState.recording = true;
      console.log(`[Camera] Video recording started on ${targetDroneId}`);
    } else if (command === 'stop_rec' || command === 'stopRec') {
      cameraState.recording = false;
      console.log(`[Camera] Video recording stopped on ${targetDroneId}`);
    } else if (command === 'zoom') {
      cameraState.zoom = Number(zoom) || 1.0;
      console.log(`[Camera] Zoom set to ${cameraState.zoom}x on ${targetDroneId}`);
    } else if (command === 'tilt') {
      cameraState.tilt_deg = Number(tilt) || -45;
      console.log(`[Camera] Tilt set to ${cameraState.tilt_deg}° on ${targetDroneId}`);
    }

    if (isDbConnected()) {
      await Drone.findOneAndUpdate(
        { drone_id: targetDroneId },
        {
          'camera.recording': cameraState.recording,
          'camera.zoom': cameraState.zoom,
          'camera.tilt_deg': cameraState.tilt_deg
        }
      ).catch(() => {});
    }

    if (io) {
      io.emit('camera_update', cameraState);
    }

    res.json({ success: true, camera: cameraState });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
