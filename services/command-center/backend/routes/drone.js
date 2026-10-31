const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns');
const Detection = require('../models/Detection');
const Drone = require('../models/Drone');
const Telemetry = require('../models/Telemetry');
const { broadcastFrame } = require('../videoStream');
const { computeDashboardStats } = require('./api');
const detectionStore = require('../detectionStore');
const {
  ECOWING_OPERATOR_TOKEN,
  validateOperatorTokenConfig,
  verifyOperatorToken
} = require('../middleware/auth');

// In-memory drone state when MongoDB is offline
const memoryDrones = new Map();

let nextEventId = 1;

// Initialize nextEventId from highest event_id in database
(async () => {
  try {
    const highest = await Detection.findOne().sort({ event_id: -1 });
    if (highest && highest.event_id) {
      nextEventId = highest.event_id + 1;
    }
  } catch (e) {}
})();

// Target address allowlist for drone connections (default: empty)
const DRONE_TARGET_ALLOWLIST = (process.env.DRONE_TARGET_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Validates drone target address / URL with anti-SSRF and DNS rebinding prevention.
 * Resolves hostnames, verifies every returned address against DRONE_TARGET_ALLOWLIST,
 * and constructs a connectUrl targeting the verified IP directly.
 */
async function validateTarget(target, { resolver } = {}) {
  if (!target) return { ok: true, host: '', validatedUrl: null, connectUrl: null, verifiedIp: null };
  const rawInput = String(target).trim();
  let rawHost = rawInput;
  if (rawHost.includes('://')) {
    const afterProto = rawHost.split('://')[1].split('/')[0].split('?')[0].split('#')[0];
    rawHost = afterProto;
  }
  // Check for user-info tricks (e.g. http://localhost@evil.com)
  if (rawHost.includes('@')) {
    return { ok: false, error: 'User-info in URL is prohibited (potential SSRF spoofing).' };
  }
  // Remove port if present
  if (rawHost.startsWith('[')) {
    const idx = rawHost.indexOf(']');
    if (idx !== -1) {
      rawHost = rawHost.substring(1, idx);
    }
  } else {
    rawHost = rawHost.split(':')[0];
  }

  // Reject decimal IPv4 (e.g. 2130706433)
  if (/^\d+$/.test(rawHost)) {
    return { ok: false, error: 'Decimal IPv4 representation rejected.' };
  }
  // Reject octal or shortened IPv4 (e.g. 0177.0.0.1 or 127.1)
  if (/^[\d\.]+$/.test(rawHost)) {
    const parts = rawHost.split('.');
    if (parts.length !== 4) {
      return { ok: false, error: 'Shortened or invalid numeric IPv4 representation rejected.' };
    }
    for (const part of parts) {
      if (part.length > 1 && part.startsWith('0')) {
        return { ok: false, error: 'Octal IPv4 representation rejected.' };
      }
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) {
        return { ok: false, error: 'IPv4 octet out of bounds.' };
      }
    }
  }

  // Parse standard URL if needed
  let urlObj = null;
  if (rawInput.includes('://')) {
    try {
      urlObj = new URL(rawInput);
    } catch (e) {
      return { ok: false, error: 'Malformed URL.' };
    }
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return { ok: false, error: 'Invalid URL protocol (must be http:// or https://).' };
    }
    if (urlObj.username || urlObj.password) {
      return { ok: false, error: 'User-info in URL is prohibited (potential SSRF spoofing).' };
    }
  }

  const finalHost = (urlObj ? urlObj.hostname : rawHost).toLowerCase().replace(/^\[|\]$/g, '');
  let verifiedIp = null;

  if (net.isIP(finalHost)) {
    // Target is an IP literal
    if (!DRONE_TARGET_ALLOWLIST.includes(finalHost) && !DRONE_TARGET_ALLOWLIST.includes(`[${finalHost}]`)) {
      return { ok: false, error: `Target host '${finalHost}' is not permitted by DRONE_TARGET_ALLOWLIST.` };
    }
    verifiedIp = finalHost;
  } else {
    // Target is a hostname: verify hostname in allowlist, then resolve and verify every resolved IP
    if (!DRONE_TARGET_ALLOWLIST.includes(finalHost)) {
      return { ok: false, error: `Target host '${finalHost}' is not permitted by DRONE_TARGET_ALLOWLIST.` };
    }

    const resolveFn = resolver || dns.promises.lookup;
    let addresses = [];
    try {
      const res = await resolveFn(finalHost, { all: true });
      addresses = Array.isArray(res) ? res : [res];
    } catch (err) {
      return { ok: false, error: `Failed to resolve target hostname '${finalHost}': ${err.message}` };
    }

    if (!addresses || addresses.length === 0) {
      return { ok: false, error: `Target hostname '${finalHost}' resolved to no addresses.` };
    }

    // DNS REBINDING DEFENSE: Check EVERY returned address against allowlist
    for (const addr of addresses) {
      const resolvedIp = (addr.address || '').toLowerCase();
      if (!DRONE_TARGET_ALLOWLIST.includes(resolvedIp)) {
        return {
          ok: false,
          error: `DNS rebinding protection: target hostname '${finalHost}' resolved to address '${resolvedIp}' which is not in DRONE_TARGET_ALLOWLIST.`
        };
      }
    }
    verifiedIp = addresses[0].address;
  }

  // Construct connectUrl connecting to the verified IP directly
  let connectUrl = null;
  if (urlObj) {
    const connectUrlObj = new URL(urlObj.href);
    connectUrlObj.hostname = verifiedIp.includes(':') ? `[${verifiedIp}]` : verifiedIp;
    connectUrl = connectUrlObj.href;
  }

  return {
    ok: true,
    host: finalHost,
    validatedUrl: urlObj ? urlObj.href : null,
    connectUrl: connectUrl,
    verifiedIp: verifiedIp,
    originalHost: finalHost
  };
}

/**
 * GET /api/drone/info
 * Returns connection info and ingestion endpoints for drone pilots & onboard companion computers
 */
router.get('/info', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const proto = req.protocol || 'http';
  const base = `${proto}://${host}`;

  res.json({
    status: 'online',
    base_url: base,
    endpoints: {
      telemetry: `${base}/api/drone/telemetry`,
      detection: `${base}/api/drone/detection`,
      stream_frame: `${base}/api/drone/stream-frame`,
      connect: `${base}/api/drone/connect`,
      disconnect: `${base}/api/drone/disconnect`,
      video_feed: `${base}/video_feed`,
      socket_io: `${base}`
    }
  });
});

/**
 * POST /api/drone/connect
 * Register or connect a drone to the command center (Operator Protected)
 */
router.post('/connect', verifyOperatorToken, async (req, res) => {
  try {
    const { drone_id, name, address, stream_url } = req.body;
    if (!drone_id) {
      return res.status(400).json({ error: 'drone_id is required' });
    }

    if (address) {
      const vAddr = await validateTarget(address);
      if (!vAddr.ok) {
        return res.status(400).json({ error: vAddr.error });
      }
    }

    if (stream_url) {
      const vStream = await validateTarget(stream_url);
      if (!vStream.ok) {
        return res.status(400).json({ error: vStream.error });
      }

      // Fetch verified IP directly with redirects disabled, timeout, and original Host header
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const fetchTarget = vStream.connectUrl || vStream.validatedUrl;
        const fetchHeaders = {};
        if (vStream.originalHost) {
          fetchHeaders['Host'] = vStream.originalHost;
        }

        const fetchRes = await fetch(fetchTarget, {
          method: 'GET',
          headers: fetchHeaders,
          redirect: 'manual', // STRICTLY DISABLE REDIRECTS
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        // Strictly reject HTTP redirects (300-399)
        if (fetchRes.status >= 300 && fetchRes.status < 400) {
          if (fetchRes.body && typeof fetchRes.body.cancel === 'function') {
            await fetchRes.body.cancel();
          }
          return res.status(400).json({
            error: 'Target URL returned a redirect, which is strictly prohibited for drone streams.'
          });
        }

        // Cancel response stream body immediately after header verification to prevent hanging sockets
        if (fetchRes.body && typeof fetchRes.body.cancel === 'function') {
          await fetchRes.body.cancel();
        }
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        return res.status(400).json({
          error: `Failed to fetch validated stream target: ${fetchErr.message}`
        });
      }
    }

    if (mongoose.connection.readyState !== 1) {
      const fallbackDrone = {
        drone_id,
        name: name || drone_id,
        status: 'Flying',
        is_connected: true,
        is_active: true,
        stream_url: stream_url || '',
        last_seen: new Date(),
        telemetry: {
          status: 'Flying',
          battery_pct: 98,
          altitude_m: 14.5,
          speed_mps: 4.5
        }
      };
      memoryDrones.set(drone_id, fallbackDrone);
      return res.json({ success: true, drone: fallbackDrone, mode: 'memory' });
    }

    const droneCount = await Drone.countDocuments({ is_active: true });
    const shouldBeActive = droneCount === 0;

    const drone = await Drone.findOneAndUpdate(
      { drone_id },
      {
        name: name || drone_id,
        status: 'Idle',
        is_connected: true,
        is_active: shouldBeActive,
        stream_url: stream_url || '',
        last_seen: new Date()
      },
      { upsert: true, new: true }
    );

    const io = req.app.get('io');
    if (io) {
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
      io.emit('telemetry_update', {
        active_drone: drone.is_active ? drone.drone_id : null,
        all_drones: stats.all_drones,
        telemetry: drone.telemetry
      });
    }

    res.json({ success: true, drone });
  } catch (err) {
    console.error('Error connecting drone:', err);
    res.status(500).json({ error: 'Failed to connect drone' });
  }
});

/**
 * POST /api/drone/disconnect
 * Disconnect a drone
 */
router.post('/disconnect', async (req, res) => {
  try {
    const { drone_id } = req.body;
    if (!drone_id) {
      return res.status(400).json({ error: 'drone_id is required' });
    }

    if (mongoose.connection.readyState !== 1) {
      memoryDrones.delete(drone_id);
      return res.json({ success: true, message: `Drone ${drone_id} disconnected (memory mode)` });
    }

    const drone = await Drone.findOneAndUpdate(
      { drone_id },
      { is_connected: false, status: 'Idle', is_active: false },
      { new: true }
    );

    const io = req.app.get('io');
    if (io) {
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
    }

    res.json({ success: true, message: `Drone ${drone_id} disconnected` });
  } catch (err) {
    console.error('Error disconnecting drone:', err);
    res.status(500).json({ error: 'Failed to disconnect drone' });
  }
});

/**
 * POST /api/drone/telemetry
 * Ingest live telemetry from the connected drone and store in MongoDB
 */
router.post('/telemetry', async (req, res) => {
  try {
    const data = req.body;
    const drone_id = data.drone_id || 'Drone-01';

    // E2: Input validation on drone_id, coordinates, and battery
    if (!drone_id || typeof drone_id !== 'string' || !/^[a-zA-Z0-9_\-]+$/.test(drone_id) || drone_id.length > 64) {
      return res.status(400).json({ error: 'Invalid drone_id. Must be alphanumeric with hyphens/underscores (max 64 chars).' });
    }

    if (data.battery_pct !== undefined) {
      const batt = Number(data.battery_pct);
      if (isNaN(batt) || batt < 0 || batt > 100) {
        return res.status(400).json({ error: 'battery_pct must be a valid number between 0 and 100.' });
      }
    }

    const rawLat = data.latitude !== undefined ? data.latitude : (data.location && data.location.lat);
    if (rawLat !== undefined) {
      const lat = Number(rawLat);
      if (isNaN(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'latitude must be a valid number between -90 and 90.' });
      }
    }

    const rawLng = data.longitude !== undefined ? data.longitude : (data.location && data.location.lng);
    if (rawLng !== undefined) {
      const lng = Number(rawLng);
      if (isNaN(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'longitude must be a valid number between -180 and 180.' });
      }
    }

    if (data.altitude_m !== undefined) {
      const alt = Number(data.altitude_m);
      if (isNaN(alt) || alt < -100 || alt > 10000) {
        return res.status(400).json({ error: 'altitude_m must be a valid number between -100 and 10000.' });
      }
    }

    if (data.speed_mps !== undefined) {
      const spd = Number(data.speed_mps);
      if (isNaN(spd) || spd < 0 || spd > 100) {
        return res.status(400).json({ error: 'speed_mps must be a valid number between 0 and 100.' });
      }
    }

    if (data.heading_deg !== undefined) {
      const hdg = Number(data.heading_deg);
      if (isNaN(hdg) || hdg < 0 || hdg > 360) {
        return res.status(400).json({ error: 'heading_deg must be a valid number between 0 and 360.' });
      }
    }

    if (data.signal_strength_pct !== undefined) {
      const sig = Number(data.signal_strength_pct);
      if (isNaN(sig) || sig < 0 || sig > 100) {
        return res.status(400).json({ error: 'signal_strength_pct must be a valid number between 0 and 100.' });
      }
    }

    if (mongoose.connection.readyState !== 1) {
      const io = req.app.get('io');
      if (io) {
        io.emit('telemetry_update', {
          active_drone: drone_id,
          telemetry: data
        });
      }
      return res.json({ success: true, mode: 'memory' });
    }

    const telemetryDoc = new Telemetry({
      drone_id,
      timestamp: new Date(),
      status: data.status || 'Active',
      battery_pct: data.battery_pct !== undefined ? data.battery_pct : 100,
      altitude_m: data.altitude_m || 0,
      speed_mps: data.speed_mps || 0,
      heading_deg: data.heading_deg || 0,
      location: {
        lat: data.latitude || (data.location && data.location.lat) || 0,
        lng: data.longitude || (data.location && data.location.lng) || 0
      },
      signal_strength_pct: data.signal_strength_pct || 100
    });
    await telemetryDoc.save();

    await Drone.findOneAndUpdate(
      { drone_id },
      {
        last_seen: new Date(),
        status: data.status || 'Active',
        telemetry: data
      }
    );

    const io = req.app.get('io');
    if (io) {
      const stats = await computeDashboardStats();
      io.emit('stats_update', stats);
      io.emit('telemetry_update', {
        active_drone: drone_id,
        all_drones: stats.all_drones,
        telemetry: data
      });
    }

    res.json({ success: true, id: telemetryDoc._id });
  } catch (err) {
    console.error('Error saving drone telemetry:', err);
    res.status(500).json({ error: 'Failed to save telemetry' });
  }
});

/**
 * POST /api/drone/detection
 * Ingest a waste detection event from the AI camera and broadcast to dashboard
 */
router.post('/detection', async (req, res) => {
  try {
    const data = req.body;
    const rawClass = data.class_name || (data.waste_type ? String(data.waste_type).toLowerCase() : 'unknown');

    let recyclable = false;
    let category = 'General';
    const recClasses = ['bottle', 'can', 'cup', 'plastic', 'glass', 'paper', 'cardboard', 'metal'];
    if (recClasses.some(c => rawClass.includes(c))) {
      recyclable = true;
      if (rawClass.includes('plastic') || rawClass.includes('bottle')) category = 'Plastic';
      else if (rawClass.includes('metal') || rawClass.includes('can')) category = 'Metal';
      else if (rawClass.includes('glass')) category = 'Glass';
      else if (rawClass.includes('paper') || rawClass.includes('cardboard')) category = 'Paper';
    }

    let lat = 19.0760;
    let lng = 72.8777;
    if (data.location && typeof data.location.lat === 'number') {
      lat = data.location.lat;
      lng = data.location.lng;
    } else if (typeof data.latitude === 'number') {
      lat = data.latitude;
      lng = data.longitude;
    }

    const eventPayload = {
      event_id: nextEventId++,
      drone_id: data.drone_id || 'EcoWing-01',
      class_name: rawClass,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.85,
      category: data.category || category,
      recyclable: data.recyclable !== undefined ? Boolean(data.recyclable) : recyclable,
      location: { lat, lng },
      imageUrl: data.imageUrl || data.image_url || '',
      verified: false,
      timestamp: new Date()
    };

    detectionStore.addDetection(eventPayload);

    if (mongoose.connection.readyState === 1) {
      try {
        const detectionDoc = new Detection(eventPayload);
        await detectionDoc.save();
      } catch (dbErr) {
        console.warn('MongoDB save warning, kept in persistent store:', dbErr.message);
      }
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('new_detection', eventPayload);
      try {
        const stats = await computeDashboardStats();
        io.emit('stats_update', stats);
      } catch (e) {}
    }

    res.json({ success: true, event: eventPayload });
  } catch (err) {
    console.error('Error processing drone detection:', err);
    res.status(500).json({ error: 'Failed to process detection' });
  }
});

/**
 * POST /api/drone/stream-frame
 * Ingest live camera frames sent from drone companion computer or mobile broadcaster
 */
router.post('/stream-frame', (req, res) => {
  try {
    const { frame } = req.body;
    if (!frame) {
      return res.status(400).json({ error: 'frame buffer or base64 string is required' });
    }
    broadcastFrame(frame);
    res.json({ success: true });
  } catch (err) {
    console.error('Error ingesting stream frame:', err);
    res.status(500).json({ error: 'Failed to process stream frame' });
  }
});

module.exports = router;
module.exports.validateTarget = validateTarget;
module.exports.validateOperatorTokenConfig = validateOperatorTokenConfig;
module.exports.verifyOperatorToken = verifyOperatorToken;
