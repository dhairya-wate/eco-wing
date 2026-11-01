const mongoose = require('mongoose');

const droneSchema = new mongoose.Schema(
  {
    drone_id: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    name: {
      type: String,
      default: function () {
        return this.drone_id;
      }
    },
    status: {
      type: String,
      default: 'Idle'
    },
    battery_pct: {
      type: Number,
      default: 100
    },
    is_active: {
      type: Boolean,
      default: false
    },
    is_connected: {
      type: Boolean,
      default: false
    },
    last_seen: {
      type: Date,
      default: Date.now
    },
    telemetry: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Drone', droneSchema);

