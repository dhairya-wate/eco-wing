const mongoose = require('mongoose');
const crypto = require('crypto');

const deviceSchema = new mongoose.Schema(
  {
    device_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    name: {
      type: String,
      default: function () {
        return this.device_id;
      }
    },
    type: {
      type: String,
      enum: ['phone', 'drone'],
      required: true,
      default: 'phone',
      index: true
    },
    token_hash: {
      type: String,
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ['active', 'revoked'],
      default: 'active',
      index: true
    },
    last_seen: {
      type: Date,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
  }
);

deviceSchema.statics.hashToken = function (rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return '';
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
};

deviceSchema.statics.generateRawToken = function (prefix = 'ecowing_dev_') {
  return prefix + crypto.randomBytes(24).toString('hex');
};

module.exports = mongoose.model('Device', deviceSchema);
