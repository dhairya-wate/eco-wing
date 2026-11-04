const mongoose = require('mongoose');
const crypto = require('crypto');

const UNAMBIGUOUS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const pairingCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true
    },
    device_id: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    attempts: {
      type: Number,
      default: 0
    },
    max_attempts: {
      type: Number,
      default: 5
    },
    used: {
      type: Boolean,
      default: false
    },
    expires_at: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: false }
  }
);

pairingCodeSchema.statics.UNAMBIGUOUS_ALPHABET = UNAMBIGUOUS_ALPHABET;

pairingCodeSchema.statics.generateCode = function (length = 6) {
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += UNAMBIGUOUS_ALPHABET[bytes[i] % UNAMBIGUOUS_ALPHABET.length];
  }
  return result;
};

module.exports = mongoose.model('PairingCode', pairingCodeSchema);
