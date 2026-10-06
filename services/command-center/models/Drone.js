const mongoose = require('mongoose');

const droneSchema = new mongoose.Schema(
  {
    drone_id: {
      type: String,
      required: [true, 'Drone ID is required'],
      unique: true,
      trim: true,
      index: true
    },
    name: {
      type: String,
      required: [true, 'Drone name is required'],
      trim: true
    },
    model: {
      type: String,
      default: 'EcoWing Falcon Quad-RTK'
    },
    status: {
      type: String,
      enum: ['idle', 'survey', 'transit', 'rth', 'landed', 'charging', 'offline'],
      default: 'idle',
      index: true
    },
    battery_pct: {
      type: Number,
      min: 0,
      max: 100,
      default: 100
    },
    battery_voltage: {
      type: Number,
      default: 25.2
    },
    signal_strength: {
      type: Number,
      min: 1,
      max: 5,
      default: 5
    },
    flight_time_s: {
      type: Number,
      default: 0
    },
    flight_hours: {
      type: Number,
      default: 0.0
    },
    maintenance_status: {
      type: String,
      default: 'Nominal'
    },
    current_mission: {
      type: String,
      default: 'Standby - Pad B'
    },
    assigned_mission_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mission',
      default: null
    },
    telemetry: {
      lat: { type: Number, default: 40.7250 },
      lng: { type: Number, default: -73.9790 },
      altitude_m: { type: Number, default: 85.0 },
      speed_mps: { type: Number, default: 0.0 },
      heading_deg: { type: Number, default: 142 },
      imu_temp_c: { type: Number, default: 34.5 },
      gimbal_pitch_deg: { type: Number, default: -45 },
      wind_speed_mps: { type: Number, default: 5.2 },
      satellites: { type: Number, default: 18 }
    },
    camera: {
      recording: { type: Boolean, default: false },
      recording_started_at: { type: Date, default: null },
      zoom: { type: Number, default: 1.0 },
      tilt_deg: { type: Number, default: -45 },
      mode: { type: String, default: 'detection' },
      resolution: { type: String, default: '4K @ 60fps' }
    },
    last_telemetry_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

const Drone = mongoose.model('Drone', droneSchema);

module.exports = Drone;
