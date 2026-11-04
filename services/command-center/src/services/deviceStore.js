/**
 * EcoWing Device, Pairing Code, and Session Store
 * Implements Three-Tier Token Architecture with MongoDB persistence
 * and high-fidelity in-memory fallback for offline test environments.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const Device = require('../models/Device');
const PairingCode = require('../models/PairingCode');
const Session = require('../models/Session');

function constantTimeHashCompare(hashA, hashB) {
  if (typeof hashA !== 'string' || typeof hashB !== 'string') return false;
  if (hashA.length !== hashB.length) return false;
  const bufA = Buffer.from(hashA, 'hex');
  const bufB = Buffer.from(hashB, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class DeviceStore {
  constructor() {
    this.memoryDevices = new Map(); // device_id -> { device_id, name, type, token_hash, status, last_seen, created_at, updated_at }
    this.memoryPairingCodes = new Map(); // code -> { code, device_id, attempts, max_attempts, used, expires_at, created_at }
    this.memorySessions = new Map(); // session_id -> { session_id, device_id, token_hash, scope, status, last_seen, expires_at, created_at }
  }

  isMongoReady() {
    return mongoose.connection.readyState === 1;
  }

  /**
   * Register a new device (phone or drone).
   * Returns raw_token ONCE. Stores only SHA-256 hash.
   */
  async registerDevice({ device_id, name, type = 'phone', metadata = {} }) {
    if (!device_id || typeof device_id !== 'string') {
      throw new Error("Invalid device_id. Must be a non-empty string.");
    }
    const cleanId = device_id.trim();
    const cleanType = String(type).trim().toLowerCase();
    if (!['phone', 'drone'].includes(cleanType)) {
      throw new Error("Invalid device type. Must be 'phone' or 'drone'.");
    }

    const rawToken = Device.generateRawToken(cleanType === 'phone' ? 'ecowing_phone_' : 'ecowing_drone_');
    const tokenHash = Device.hashToken(rawToken);
    const now = new Date();

    if (this.isMongoReady()) {
      const existing = await Device.findOne({ device_id: cleanId });
      if (existing) {
        throw new Error(`Device '${cleanId}' is already registered.`);
      }
      const doc = await Device.create({
        device_id: cleanId,
        name: name ? String(name).trim() : cleanId,
        type: cleanType,
        token_hash: tokenHash,
        status: 'active',
        metadata
      });
      return {
        device_id: doc.device_id,
        name: doc.name,
        type: doc.type,
        status: doc.status,
        raw_token: rawToken,
        created_at: doc.created_at
      };
    }

    // Memory fallback
    if (this.memoryDevices.has(cleanId)) {
      throw new Error(`Device '${cleanId}' is already registered.`);
    }
    const memRecord = {
      device_id: cleanId,
      name: name ? String(name).trim() : cleanId,
      type: cleanType,
      token_hash: tokenHash,
      status: 'active',
      last_seen: null,
      metadata,
      created_at: now,
      updated_at: now
    };
    this.memoryDevices.set(cleanId, memRecord);

    return {
      device_id: memRecord.device_id,
      name: memRecord.name,
      type: memRecord.type,
      status: memRecord.status,
      raw_token: rawToken,
      created_at: memRecord.created_at
    };
  }

  /**
   * Rotate a device's authentication token.
   * Invalidates old token, revokes active sessions, and returns new raw_token ONCE.
   */
  async rotateDeviceToken(device_id) {
    if (!device_id) throw new Error("Missing device_id.");
    const cleanId = String(device_id).trim();

    const rawToken = Device.generateRawToken();
    const tokenHash = Device.hashToken(rawToken);
    const now = new Date();

    if (this.isMongoReady()) {
      const dev = await Device.findOne({ device_id: cleanId });
      if (!dev) {
        throw new Error(`Device '${cleanId}' not found.`);
      }
      dev.token_hash = tokenHash;
      dev.updated_at = now;
      await dev.save();

      // Revoke all existing sessions for this device
      await Session.updateMany({ device_id: cleanId, status: 'active' }, { status: 'revoked' });

      return {
        device_id: cleanId,
        raw_token: rawToken,
        updated_at: now
      };
    }

    // Memory fallback
    const dev = this.memoryDevices.get(cleanId);
    if (!dev) {
      throw new Error(`Device '${cleanId}' not found.`);
    }
    dev.token_hash = tokenHash;
    dev.updated_at = now;

    for (const sess of this.memorySessions.values()) {
      if (sess.device_id === cleanId && sess.status === 'active') {
        sess.status = 'revoked';
      }
    }

    return {
      device_id: cleanId,
      raw_token: rawToken,
      updated_at: now
    };
  }

  /**
   * Revoke a device and all its active sessions.
   */
  async revokeDevice(device_id) {
    if (!device_id) throw new Error("Missing device_id.");
    const cleanId = String(device_id).trim();

    if (this.isMongoReady()) {
      const dev = await Device.findOneAndUpdate(
        { device_id: cleanId },
        { status: 'revoked', updated_at: new Date() },
        { new: true }
      );
      if (!dev) throw new Error(`Device '${cleanId}' not found.`);
      await Session.updateMany({ device_id: cleanId, status: 'active' }, { status: 'revoked' });
      return { success: true, device_id: cleanId, status: 'revoked' };
    }

    const dev = this.memoryDevices.get(cleanId);
    if (!dev) throw new Error(`Device '${cleanId}' not found.`);
    dev.status = 'revoked';
    dev.updated_at = new Date();

    for (const sess of this.memorySessions.values()) {
      if (sess.device_id === cleanId && sess.status === 'active') {
        sess.status = 'revoked';
      }
    }

    return { success: true, device_id: cleanId, status: 'revoked' };
  }

  /**
   * Synchronous check against in-memory cache/store
   */
  getDeviceRecordSync(device_id) {
    if (!device_id) return null;
    return this.memoryDevices.get(String(device_id).trim()) || null;
  }

  verifyDeviceTokenSync(device_id, rawToken) {
    if (!device_id || !rawToken) return false;
    const cleanId = String(device_id).trim();
    const tokenHash = Device.hashToken(rawToken);
    const dev = this.memoryDevices.get(cleanId);
    if (!dev || dev.status !== 'active' || !dev.token_hash) return false;
    return constantTimeHashCompare(tokenHash, dev.token_hash);
  }

  /**
   * Verify a device token against stored hash using constant-time comparison.
   */
  async verifyDeviceToken(device_id, rawToken) {
    if (!device_id || !rawToken) return false;
    const cleanId = String(device_id).trim();
    const tokenHash = Device.hashToken(rawToken);

    if (this.isMongoReady()) {
      const dev = await Device.findOne({ device_id: cleanId });
      if (!dev || dev.status !== 'active') return false;
      return constantTimeHashCompare(tokenHash, dev.token_hash);
    }

    const dev = this.memoryDevices.get(cleanId);
    if (!dev || dev.status !== 'active') return false;
    return constantTimeHashCompare(tokenHash, dev.token_hash);
  }

  /**
   * List all registered devices (omits full token_hash and raw_token).
   * Returns metadata only: id, device_id, name, type, status, created_at, revoked_at, fingerprint.
   */
  async listDevices() {
    if (this.isMongoReady()) {
      const docs = await Device.find({}).sort({ created_at: -1 });
      return docs.map(d => ({
        id: d.device_id,
        device_id: d.device_id,
        name: d.name,
        type: d.type,
        status: d.status,
        created_at: d.created_at,
        revoked_at: d.status === 'revoked' ? d.updated_at : null,
        fingerprint: d.token_hash ? d.token_hash.substring(0, 8) : null
      }));
    }

    return Array.from(this.memoryDevices.values()).map(d => ({
      id: d.device_id,
      device_id: d.device_id,
      name: d.name,
      type: d.type,
      status: d.status,
      created_at: d.created_at,
      revoked_at: d.status === 'revoked' ? d.updated_at : null,
      fingerprint: d.token_hash ? d.token_hash.substring(0, 8) : null
    }));
  }

  /**
   * Create a 6-character pairing code with 5-minute TTL tied to a registered device.
   */
  async createPairingCode(device_id, ttlSeconds = 300) {
    if (!device_id) throw new Error("Missing device_id.");
    const cleanId = String(device_id).trim();

    // Verify device exists and is active
    let devExists = false;
    if (this.isMongoReady()) {
      const dev = await Device.findOne({ device_id: cleanId, status: 'active' });
      devExists = Boolean(dev);
    } else {
      const dev = this.memoryDevices.get(cleanId);
      devExists = Boolean(dev && dev.status === 'active');
    }

    if (!devExists) {
      throw new Error(`Device '${cleanId}' is not registered or not active.`);
    }

    const code = PairingCode.generateCode(6);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    if (this.isMongoReady()) {
      await PairingCode.create({
        code,
        device_id: cleanId,
        attempts: 0,
        max_attempts: 5,
        used: false,
        expires_at: expiresAt
      });
    } else {
      this.memoryPairingCodes.set(code, {
        code,
        device_id: cleanId,
        attempts: 0,
        max_attempts: 5,
        used: false,
        expires_at: expiresAt,
        created_at: new Date()
      });
    }

    return {
      code,
      device_id: cleanId,
      expires_in: ttlSeconds,
      expires_at: expiresAt.toISOString()
    };
  }

  /**
   * Verify and burn a pairing code upon exchange.
   * If invalid: increments attempts; if attempts >= 5, burns the code.
   * If valid: marks used, issues opaque session token, returns session credentials.
   */
  async verifyAndBurnPairingCode(rawCode) {
    if (!rawCode || typeof rawCode !== 'string') {
      return { valid: false, error: "Invalid pairing code format." };
    }
    const cleanCode = rawCode.trim().toUpperCase();

    if (this.isMongoReady()) {
      const entry = await PairingCode.findOne({ code: cleanCode });
      if (!entry) {
        return { valid: false, error: "Pairing code not found." };
      }
      if (entry.used) {
        return { valid: false, error: "Pairing code has already been used." };
      }
      if (entry.expires_at < new Date()) {
        await PairingCode.deleteOne({ code: cleanCode });
        return { valid: false, error: "Pairing code has expired." };
      }

      // Check max attempts
      if (entry.attempts >= entry.max_attempts) {
        entry.used = true;
        await entry.save();
        return { valid: false, error: "Pairing code burned due to excessive failed attempts." };
      }

      // Mark used immediately
      entry.used = true;
      await entry.save();

      // Issue session token
      const sessionId = 'sess_' + crypto.randomUUID();
      const rawSessionToken = Session.generateSessionToken();
      const sessionHash = Session.hashToken(rawSessionToken);
      const sessionExpiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour TTL

      await Session.create({
        session_id: sessionId,
        device_id: entry.device_id,
        token_hash: sessionHash,
        scope: ['stream', 'command'],
        status: 'active',
        expires_at: sessionExpiresAt
      });

      return {
        valid: true,
        session_id: sessionId,
        session_token: rawSessionToken,
        device_id: entry.device_id,
        expires_at: sessionExpiresAt.toISOString()
      };
    }

    // Memory fallback
    const entry = this.memoryPairingCodes.get(cleanCode);
    if (!entry) {
      return { valid: false, error: "Pairing code not found." };
    }
    if (entry.used) {
      return { valid: false, error: "Pairing code has already been used." };
    }
    if (entry.expires_at < new Date()) {
      this.memoryPairingCodes.delete(cleanCode);
      return { valid: false, error: "Pairing code has expired." };
    }

    if (entry.attempts >= entry.max_attempts) {
      entry.used = true;
      return { valid: false, error: "Pairing code burned due to excessive failed attempts." };
    }

    entry.used = true;

    const sessionId = 'sess_' + crypto.randomUUID();
    const rawSessionToken = Session.generateSessionToken();
    const sessionHash = Session.hashToken(rawSessionToken);
    const sessionExpiresAt = new Date(Date.now() + 3600 * 1000);

    this.memorySessions.set(sessionId, {
      session_id: sessionId,
      device_id: entry.device_id,
      token_hash: sessionHash,
      scope: ['stream', 'command'],
      status: 'active',
      expires_at: sessionExpiresAt,
      created_at: new Date()
    });

    return {
      valid: true,
      session_id: sessionId,
      session_token: rawSessionToken,
      device_id: entry.device_id,
      expires_at: sessionExpiresAt.toISOString()
    };
  }

  /**
   * Record a failed code attempt. If attempts reach 5, burns the code.
   */
  async recordFailedCodeAttempt(rawCode) {
    if (!rawCode) return;
    const cleanCode = String(rawCode).trim().toUpperCase();

    if (this.isMongoReady()) {
      const entry = await PairingCode.findOne({ code: cleanCode });
      if (entry) {
        entry.attempts += 1;
        if (entry.attempts >= entry.max_attempts) {
          entry.used = true;
        }
        await entry.save();
      }
      return;
    }

    const entry = this.memoryPairingCodes.get(cleanCode);
    if (entry) {
      entry.attempts += 1;
      if (entry.attempts >= entry.max_attempts) {
        entry.used = true;
      }
    }
  }

  /**
   * List all active sessions (omits token_hash).
   */
  async listActiveSessions() {
    const now = new Date();
    if (this.isMongoReady()) {
      const docs = await Session.find({ status: 'active', expires_at: { $gt: now } }, { token_hash: 0 }).sort({ created_at: -1 });
      return docs.map(s => ({
        session_id: s.session_id,
        device_id: s.device_id,
        scope: s.scope,
        status: s.status,
        last_seen: s.last_seen,
        expires_at: s.expires_at,
        created_at: s.created_at
      }));
    }

    const active = [];
    for (const s of this.memorySessions.values()) {
      if (s.status === 'active' && s.expires_at > now) {
        active.push({
          session_id: s.session_id,
          device_id: s.device_id,
          scope: s.scope,
          status: s.status,
          last_seen: s.last_seen || s.created_at,
          expires_at: s.expires_at,
          created_at: s.created_at
        });
      }
    }
    return active;
  }

  /**
   * Revoke an active session immediately.
   */
  async revokeSession(session_id) {
    if (!session_id) throw new Error("Missing session_id.");
    const cleanId = String(session_id).trim();

    if (this.isMongoReady()) {
      const sess = await Session.findOneAndUpdate(
        { session_id: cleanId },
        { status: 'revoked', updated_at: new Date() },
        { new: true }
      );
      if (!sess) throw new Error(`Session '${cleanId}' not found.`);
      return { success: true, session_id: cleanId, status: 'revoked' };
    }

    const sess = this.memorySessions.get(cleanId);
    if (!sess) throw new Error(`Session '${cleanId}' not found.`);
    sess.status = 'revoked';
    sess.updated_at = new Date();
    return { success: true, session_id: cleanId, status: 'revoked' };
  }

  /**
   * Verify an opaque session token.
   */
  async verifySessionToken(session_id, rawSessionToken) {
    if (!session_id || !rawSessionToken) return false;
    const cleanId = String(session_id).trim();
    const tokenHash = Session.hashToken(rawSessionToken);
    const now = new Date();

    if (this.isMongoReady()) {
      const sess = await Session.findOne({ session_id: cleanId });
      if (!sess || sess.status !== 'active' || sess.expires_at <= now) return false;
      return constantTimeHashCompare(tokenHash, sess.token_hash);
    }

    const sess = this.memorySessions.get(cleanId);
    if (!sess || sess.status !== 'active' || sess.expires_at <= now) return false;
    return constantTimeHashCompare(tokenHash, sess.token_hash);
  }

  /**
   * Clear test data.
   */
  clear() {
    this.memoryDevices.clear();
    this.memoryPairingCodes.clear();
    this.memorySessions.clear();
  }
}

const deviceStore = new DeviceStore();

module.exports = {
  DeviceStore,
  deviceStore,
  constantTimeHashCompare
};
