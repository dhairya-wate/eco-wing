/**
 * Device, Mobile Pairing, and Session Management Routes
 * Implements Three-Tier Token Architecture & Command Dispatching
 */

const express = require('express');
const router = express.Router();
const { deviceStore } = require('../services/deviceStore');
const { verifyOperatorToken, verifyServiceToken } = require('../middleware/auth');
const { commandManager } = require('../services/commandManager');

/**
 * GET /api/devices
 * List all registered devices (omits token_hash)
 * Protected: Operator only
 */
router.get('/devices', verifyOperatorToken, async (req, res) => {
  try {
    const devices = await deviceStore.listDevices();
    res.json({ success: true, count: devices.length, devices });
  } catch (err) {
    console.error('Error in GET /api/devices:', err);
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

/**
 * POST /api/devices
 * Register a new phone or drone device
 * Returns raw device token ONCE; stores only SHA-256 hash.
 * Protected: Operator only
 */
router.post('/devices', verifyOperatorToken, async (req, res) => {
  try {
    const { device_id, name, type, metadata } = req.body;
    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: "Missing or invalid 'device_id'." });
    }
    const cleanType = String(type || 'phone').trim().toLowerCase();
    if (!['phone', 'drone'].includes(cleanType)) {
      return res.status(400).json({ error: "Invalid 'type'. Must be 'phone' or 'drone'." });
    }

    const device = await deviceStore.registerDevice({
      device_id,
      name,
      type: cleanType,
      metadata
    });

    res.status(201).json({
      success: true,
      message: `Device '${device.device_id}' registered successfully. Keep your raw device token safe; it will not be shown again.`,
      device: {
        device_id: device.device_id,
        name: device.name,
        type: device.type,
        status: device.status,
        created_at: device.created_at
      },
      raw_token: device.raw_token
    });
  } catch (err) {
    console.error('Error in POST /api/devices:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/devices/:id/rotate-token
 * Rotates device token and revokes associated active sessions.
 * Protected: Operator only
 */
router.post('/devices/:id/rotate-token', verifyOperatorToken, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const result = await deviceStore.rotateDeviceToken(deviceId);

    // Notify connected clients via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('device_token_rotated', { device_id: deviceId });
    }

    res.json({
      success: true,
      message: `Device token for '${deviceId}' rotated successfully.`,
      device_id: deviceId,
      raw_token: result.raw_token,
      updated_at: result.updated_at
    });
  } catch (err) {
    console.error('Error in POST /api/devices/:id/rotate-token:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/devices/:id/revoke
 * Revokes a device and its active sessions.
 * Protected: Operator only
 */
router.post('/devices/:id/revoke', verifyOperatorToken, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const result = await deviceStore.revokeDevice(deviceId);

    const io = req.app.get('io');
    if (io) {
      io.emit('device_revoked', { device_id: deviceId });
    }

    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/devices/:id/revoke:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/mobile/config
 * Returns public configuration for mobile pairing.
 * Builds URLs exclusively from ECOWING_PUBLIC_URL.
 */
router.get('/mobile/config', (req, res) => {
  const ecowingPublicUrl = process.env.ECOWING_PUBLIC_URL ? process.env.ECOWING_PUBLIC_URL.replace(/\/+$/, '') : null;
  res.json({
    success: true,
    ecowing_public_url: ecowingPublicUrl,
    mobile_path: '/mobile'
  });
});

/**
 * POST /api/mobile/pairing_code
 * Generates single-use 6-character pairing code with 5-minute TTL.
 * Protected: Operator only
 */
router.post('/mobile/pairing_code', verifyOperatorToken, async (req, res) => {
  try {
    let deviceId = req.body.device_id;

    // If no device_id supplied, look up or auto-register a default phone sensor
    if (!deviceId) {
      const devices = await deviceStore.listDevices();
      const phone = devices.find(d => d.type === 'phone' && d.status === 'active');
      if (phone) {
        deviceId = phone.device_id;
      } else {
        const autoReg = await deviceStore.registerDevice({
          device_id: 'phone-' + Math.floor(1000 + Math.random() * 9000),
          name: 'Mobile Broadcaster',
          type: 'phone'
        });
        deviceId = autoReg.device_id;
      }
    }

    const ttlSeconds = Number(req.body.ttl_seconds) || 300;
    const pairing = await deviceStore.createPairingCode(deviceId, ttlSeconds);

    const ecowingPublicUrl = process.env.ECOWING_PUBLIC_URL ? process.env.ECOWING_PUBLIC_URL.replace(/\/+$/, '') : null;
    const mobileUrl = ecowingPublicUrl ? `${ecowingPublicUrl}/mobile?code=${pairing.code}` : null;

    const io = req.app.get('io');
    if (io) {
      io.emit('pairing_code_generated', {
        code: pairing.code,
        device_id: pairing.device_id,
        expires_at: pairing.expires_at,
        mobile_url: mobileUrl
      });
    }

    res.json({
      success: true,
      code: pairing.code,
      device_id: pairing.device_id,
      expires_in: pairing.expires_in,
      expires_at: pairing.expires_at,
      mobile_url: mobileUrl
    });
  } catch (err) {
    console.error('Error in POST /api/mobile/pairing_code:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/mobile/verify_code
 * Exchanges pairing code for a scoped session token.
 * Single-use: burns the code on success. Rate-limited: burns on 5 failures.
 * Protected: Internal Detection Service or Operator
 */
router.post('/mobile/verify_code', verifyServiceToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: "Missing or invalid 'code'." });
    }

    const result = await deviceStore.verifyAndBurnPairingCode(code);
    if (!result.valid) {
      await deviceStore.recordFailedCodeAttempt(code);
      return res.status(401).json({
        success: false,
        error: result.error || "Invalid, expired, or already used pairing code."
      });
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('session_created', {
        session_id: result.session_id,
        device_id: result.device_id,
        expires_at: result.expires_at
      });
    }

    res.json({
      success: true,
      session_id: result.session_id,
      session_token: result.session_token,
      device_id: result.device_id,
      expires_at: result.expires_at,
      scope: ['stream', 'command']
    });
  } catch (err) {
    console.error('Error in POST /api/mobile/verify_code:', err);
    res.status(500).json({ error: 'Failed to verify pairing code' });
  }
});

/**
 * GET /api/mobile/sessions
 * List active phone sessions
 * Protected: Operator only
 */
router.get('/mobile/sessions', verifyOperatorToken, async (req, res) => {
  try {
    const sessions = await deviceStore.listActiveSessions();
    res.json({ success: true, count: sessions.length, sessions });
  } catch (err) {
    console.error('Error in GET /api/mobile/sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * POST /api/mobile/revoke-session
 * Revoke an active phone session immediately.
 * Protected: Operator or Service
 */
router.post('/mobile/revoke-session', async (req, res, next) => {
  // Allow operator or service token
  const opToken = req.headers['x-operator-token'];
  const srvToken = req.headers['x-service-token'] || req.headers['authorization'];
  if (opToken) {
    return verifyOperatorToken(req, res, () => handleRevokeSession(req, res));
  }
  if (srvToken) {
    return verifyServiceToken(req, res, () => handleRevokeSession(req, res));
  }
  return res.status(401).json({ error: "Unauthorized: provide 'X-Operator-Token' or 'X-Service-Token' header." });
});

async function handleRevokeSession(req, res) {
  try {
    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: "Missing required 'session_id'." });
    }

    const result = await deviceStore.revokeSession(session_id);

    const io = req.app.get('io');
    if (io) {
      io.emit('session_revoked', { session_id });
      io.to(`session:${session_id}`).emit('session_revoked', { session_id });
    }

    res.json({
      success: true,
      message: `Session '${session_id}' revoked successfully.`,
      session_id
    });
  } catch (err) {
    console.error('Error in POST /api/mobile/revoke-session:', err);
    res.status(400).json({ error: err.message });
  }
}

module.exports = router;
