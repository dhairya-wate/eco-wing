const mongoose = require('mongoose');

const waypointSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    alt_m: { type: Number, default: 100 },
    action: { type: String, default: 'fly_through' }
  },
  { _id: false }
);

const missionSchema = new mongoose.Schema(
  {
    mission_id: {
      type: String,
      required: [true, 'Mission ID is required'],
      unique: true,
      trim: true,
      index: true
    },
    name: {
      type: String,
      required: [true, 'Mission name is required'],
      trim: true
    },
    status: {
      type: String,
      enum: ['planned', 'active', 'paused', 'completed', 'aborted'],
      default: 'planned',
      index: true
    },
    drone_id: {
      type: String,
      default: 'Drone-01'
    },
    altitude_m: {
      type: Number,
      default: 100
    },
    speed_mps: {
      type: Number,
      default: 8
    },
    overlap_pct: {
      type: Number,
      default: 70
    },
    waypoints: [waypointSchema],
    estimated_distance_m: {
      type: Number,
      default: 0
    },
    estimated_duration_s: {
      type: Number,
      default: 0
    },
    estimated_battery_burn_pct: {
      type: Number,
      default: 0
    },
    total_detections_count: {
      type: Number,
      default: 0
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    completedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

const Mission = mongoose.model('Mission', missionSchema);

module.exports = Mission;
