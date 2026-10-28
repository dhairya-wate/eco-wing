const mongoose = require('mongoose');

function inferMaterialType(name) {
  const s = String(name || '').toLowerCase().replace(/[-_]/g, ' ');
  if (['food', 'organic', 'leaf', 'leaves', 'wood', 'plant', 'fruit', 'vegetable', 'peel', 'apple', 'banana', 'cotton', 'compost', 'straw'].some(k => s.includes(k))) {
    return 'Biodegradable';
  }
  if (['bottle', 'can', 'aluminum', 'metal', 'tin', 'glass', 'cardboard', 'paper', 'carton', 'tetra', 'jar', 'hdpe', 'pet'].some(k => s.includes(k))) {
    return 'Recyclable';
  }
  if (s.includes('plastic') && !s.includes('bag') && !s.includes('wrap') && !s.includes('film')) {
    return 'Recyclable';
  }
  return 'Non-Recyclable';
}

const detectionSchema = new mongoose.Schema(
  {
    event_id: {
      type: Number,
      required: true,
      index: true
    },
    drone_id: {
      type: String,
      default: 'Drone-01',
      index: true
    },
    class_name: {
      type: String,
      required: true,
      index: true
    },
    material_type: {
      type: String,
      enum: ['Recyclable', 'Biodegradable', 'Non-Recyclable'],
      default: function () {
        return inferMaterialType(this.class_name);
      },
      index: true
    },
    confidence: {
      type: Number,
      required: true,
      min: 0,
      max: 1
    },
    center: {
      type: [Number], // [x, y]
      required: true,
      validate: {
        validator: function (v) {
          return Array.isArray(v) && v.length === 2;
        },
        message: 'Center must be a 2-element array [x, y]'
      }
    },
    timestamp: {
      type: String,
      default: () => {
        const d = new Date();
        return d.toISOString().replace('T', ' ').substring(0, 19);
      }
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

detectionSchema.methods.toEventJSON = function () {
  return {
    event_id: this.event_id,
    class_name: this.class_name,
    material_type: this.material_type || inferMaterialType(this.class_name),
    confidence: this.confidence,
    center: this.center,
    timestamp: this.timestamp
  };
};

module.exports = mongoose.model('Detection', detectionSchema);
module.exports.inferMaterialType = inferMaterialType;
