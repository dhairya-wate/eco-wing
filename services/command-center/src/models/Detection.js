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

function inferDualAxisClassification(name, item = {}) {
  const s = String(name || '').toLowerCase().replace(/[-_]/g, ' ');
  let isRec = false;
  let isBio = false;

  if (item.recyclable !== undefined) {
    isRec = ['yes', 'true', 'estimated'].includes(String(item.recyclable).toLowerCase()) || item.recyclable === true;
  } else {
    if (['bottle', 'can', 'aluminum', 'metal', 'tin', 'glass', 'cardboard', 'paper', 'carton', 'tetra', 'jar', 'hdpe', 'pet'].some(k => s.includes(k))) {
      isRec = true;
    } else if (s.includes('plastic') && !s.includes('bag') && !s.includes('wrap') && !s.includes('film')) {
      isRec = true;
    }
  }

  if (item.biodegradable !== undefined) {
    isBio = ['yes', 'true', 'estimated'].includes(String(item.biodegradable).toLowerCase()) || item.biodegradable === true;
  } else {
    if (['food', 'organic', 'leaf', 'leaves', 'wood', 'plant', 'fruit', 'vegetable', 'peel', 'apple', 'banana', 'cotton', 'compost', 'straw', 'paper', 'cardboard'].some(k => s.includes(k))) {
      isBio = true;
    }
  }

  let materialType = 'Non-Recyclable';
  if (isRec) materialType = 'Recyclable';
  else if (isBio) materialType = 'Biodegradable';

  let bin = 'Black/Cyan Bin (Residual)';
  if (isRec && isBio) bin = 'Blue/Green Bin (Dual-Stream)';
  else if (isRec) bin = 'Blue Bin (Recyclable)';
  else if (isBio) bin = 'Green Bin (Compostable)';

  return {
    is_recyclable: isRec,
    is_biodegradable: isBio,
    recyclable: isRec ? 'yes' : 'no',
    biodegradable: isBio ? 'yes' : 'no',
    material_type: materialType,
    disposal_bin: bin
  };
}

const detectionSchema = new mongoose.Schema(
  {
    event_id: {
      type: Number,
      required: true,
      index: true
    },
    canonical_event_id: {
      type: String,
      sparse: true,
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
    coco_label: {
      type: String
    },
    category: {
      type: String,
      default: 'General'
    },
    material: {
      type: String,
      default: 'unknown'
    },
    material_type: {
      type: String,
      enum: ['Recyclable', 'Biodegradable', 'Non-Recyclable'],
      set: function (v) {
        if (['Recyclable', 'Biodegradable', 'Non-Recyclable'].includes(v)) return v;
        return inferMaterialType(this.class_name || v);
      },
      default: function () {
        return inferMaterialType(this.class_name);
      },
      index: true
    },
    is_recyclable: {
      type: Boolean,
      default: function () {
        return inferDualAxisClassification(this.class_name).is_recyclable;
      },
      index: true
    },
    is_biodegradable: {
      type: Boolean,
      default: function () {
        return inferDualAxisClassification(this.class_name).is_biodegradable;
      },
      index: true
    },
    recyclable: {
      type: String,
      default: function () {
        return this.is_recyclable ? 'yes' : 'no';
      }
    },
    biodegradable: {
      type: String,
      default: function () {
        return this.is_biodegradable ? 'yes' : 'no';
      }
    },
    disposal_bin: {
      type: String,
      default: function () {
        return inferDualAxisClassification(this.class_name).disposal_bin;
      }
    },
    confidence: {
      type: Number,
      required: true,
      set: function (v) {
        const n = Number(v) || 0;
        return n > 1 ? Number((n / 100).toFixed(2)) : Number(n.toFixed(2));
      },
      min: 0,
      max: 1
    },
    center: {
      type: [Number], // [x, y]
      default: [320, 240],
      validate: {
        validator: function (v) {
          return !v || (Array.isArray(v) && v.length === 2);
        },
        message: 'Center must be a 2-element array [x, y]'
      }
    },
    bbox: {
      type: [Number],
      default: []
    },
    location: {
      lat: { type: Number, default: 19.0760 },
      lng: { type: Number, default: 72.8777 }
    },
    imageUrl: {
      type: String,
      default: ''
    },
    verified: {
      type: Boolean,
      default: false
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
    canonical_event_id: this.canonical_event_id,
    drone_id: this.drone_id,
    class_name: this.class_name,
    material_type: this.material_type || inferMaterialType(this.class_name),
    is_recyclable: this.is_recyclable,
    is_biodegradable: this.is_biodegradable,
    recyclable: this.recyclable,
    biodegradable: this.biodegradable,
    disposal_bin: this.disposal_bin,
    confidence: this.confidence,
    center: this.center,
    timestamp: this.timestamp
  };
};

module.exports = mongoose.model('Detection', detectionSchema);
module.exports.inferMaterialType = inferMaterialType;
module.exports.inferDualAxisClassification = inferDualAxisClassification;
