const mongoose = require('mongoose');

const siteAnalysisSchema = new mongoose.Schema(
  {
    total_detections: {
      type: Number,
      default: 0
    },
    recyclable_count: {
      type: Number,
      default: 0
    },
    non_recyclable_count: {
      type: Number,
      default: 0
    },
    biodegradable_count: {
      type: Number,
      default: 0
    },
    non_biodegradable_count: {
      type: Number,
      default: 0
    },
    recyclable_percentage: {
      type: Number,
      default: 0
    },
    biodegradable_percentage: {
      type: Number,
      default: 0
    },
    classes: [
      {
        name: { type: String, required: true },
        count: { type: Number, default: 0 },
        is_recyclable: { type: Boolean, default: false },
        is_biodegradable: { type: Boolean, default: false },
        category: { type: String, default: 'General' },
        disposal_bin: { type: String, default: 'Black/Cyan Bin' }
      }
    ],
    source: {
      type: String,
      default: 'ecowing_command_center'
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

module.exports = mongoose.model('SiteAnalysis', siteAnalysisSchema);
