const mongoose = require('mongoose');

const telemetryLogSchema = new mongoose.Schema(
  {
    drone_id: {
      type: String,
      required: true,
      index: true
    },
    mission_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mission',
      default: null
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true
    },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    altitude_m: { type: Number, required: true },
    speed_mps: { type: Number, required: true },
    heading_deg: { type: Number, default: 0 },
    battery_pct: { type: Number, required: true },
    battery_voltage: { type: Number, default: 24.0 },
    satellites: { type: Number, default: 16 },
    imu_temp_c: { type: Number, default: 35.0 },
    wind_speed_mps: { type: Number, default: 5.0 },
    gimbal_pitch_deg: { type: Number, default: -45 },
    status: { type: String, default: 'active' }
  },
  {
    timestamps: false
  }
);

// Compound index for querying a drone's telemetry over time
telemetryLogSchema.index({ drone_id: 1, timestamp: -1 });

const TelemetryLog = mongoose.model('TelemetryLog', telemetryLogSchema);

module.exports = TelemetryLog;
