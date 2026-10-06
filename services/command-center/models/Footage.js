const mongoose = require('mongoose');

const footageSchema = new mongoose.Schema(
  {
    flight_id: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    site: {
      type: String,
      required: true,
      trim: true
    },
    flight_date: {
      type: Date,
      default: Date.now
    },
    size_gb: {
      type: Number,
      default: 0
    },
    images_count: {
      type: Number,
      default: 0
    },
    resolution: {
      type: String,
      default: '4K UHD'
    },
    duration: {
      type: String,
      default: '00:00'
    },
    hotspots_found: {
      type: Number,
      default: 0
    },
    avg_confidence: {
      type: Number,
      default: 0
    },
    tags: {
      type: [String],
      default: ['RGB 4K']
    },
    drone_id: {
      type: String,
      default: 'Drone-01'
    },
    video_url: {
      type: String,
      default: ''
    },
    cloud_synced: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Footage', footageSchema);
