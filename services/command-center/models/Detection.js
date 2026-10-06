const mongoose = require('mongoose');

const detectionSchema = new mongoose.Schema(
  {
    event_id: {
      type: String,
      required: [true, 'Event ID is required'],
      unique: true,
      trim: true,
      index: true
    },
    class_name: {
      type: String,
      required: [true, 'Waste class name is required'],
      trim: true,
      index: true
    },
    confidence: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
      index: true
    },
    drone_id: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    mission_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mission',
      default: null
    },
    center: {
      type: [Number], // [latitude, longitude] or [x, y] format expected by UI
      required: true
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude] GeoJSON standard
        required: true,
        default: [-73.9790, 40.7250]
      }
    },
    bbox: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
      w: { type: Number, default: 50 },
      h: { type: Number, default: 50 }
    },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium'
    },
    estimated_area_m2: {
      type: Number,
      default: 0.15
    },
    estimated_weight_kg: {
      type: Number,
      default: 0.25
    },
    status: {
      type: String,
      enum: ['detected', 'verified', 'dispatched', 'cleared'],
      default: 'detected',
      index: true
    },
    timestamp: {
      type: String,
      default: () => new Date().toLocaleTimeString('en-US', { hour12: false })
    }
  },
  {
    timestamps: true
  }
);

// 2dsphere index on location for GeoJSON spatial queries
detectionSchema.index({ location: '2dsphere' });
detectionSchema.index({ createdAt: -1 });

const Detection = mongoose.model('Detection', detectionSchema);

module.exports = Detection;
