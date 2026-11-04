const mongoose = require('mongoose');
const crypto = require('crypto');

const sessionSchema = new mongoose.Schema(
  {
    session_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    device_id: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    token_hash: {
      type: String,
      required: true,
      index: true
    },
    scope: {
      type: [String],
      default: ['stream', 'command']
    },
    status: {
      type: String,
      enum: ['active', 'revoked', 'expired'],
      default: 'active',
      index: true
    },
    last_seen: {
      type: Date,
      default: Date.now
    },
    expires_at: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
  }
);

sessionSchema.statics.hashToken = function (rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return '';
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
};

sessionSchema.statics.generateSessionToken = function (prefix = 'ecowing_sess_') {
  return prefix + crypto.randomBytes(24).toString('hex');
};

module.exports = mongoose.model('Session', sessionSchema);
