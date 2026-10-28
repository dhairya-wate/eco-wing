const mongoose = require('mongoose');

const telemetrySchema = new mongoose.Schema(
  {
    drone_id: {
      type: String,
      required: true,
      index: true
    },
    status: {
      type: String,
      default: 'Idle',
      enum: ['Flying', 'Holding', 'Returning', 'Landing', 'Idle', 'Charging', 'Landed', 'estop', 'flying', 'hold', 'returning', 'landing', 'idle', 'charging']
    },
    battery_pct: {
      type: Number,
      default: 100,
      min: 0,
      max: 100
    },
    battery_voltage: {
      type: Number,
      default: 8.4
    },
    altitude_m: {
      type: Number,
      default: 0.0
    },
    speed_mps: {
      type: Number,
      default: 0.0
    },
    imu_temp_c: {
      type: Number,
      default: 25.0
    },
    gimbal_pitch_deg: {
      type: Number,
      default: 0
    },
    wind_speed_mps: {
      type: Number,
      default: 0.0
    },
    satellites: {
      type: Number,
      default: 0
    },
    heading_deg: {
      type: Number,
      default: 0
    },
    lat: {
      type: Number,
      default: 0.0
    },
    lng: {
      type: Number,
      default: 0.0
    },
    flight_time_s: {
      type: Number,
      default: 0
    },
    mission: {
      type: String,
      default: 'Standby'
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Telemetry', telemetrySchema);

