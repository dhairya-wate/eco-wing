/**
 * Live drone video stream simulation.
 * Serves an MJPEG stream (multipart/x-mixed-replace) representing the down-facing
 * camera feed with dynamic HUD overlays, artificial horizon, altitude, speed,
 * and AI detection boxes!
 */
const express = require('express');
const router = express.Router();

// Simple minimalist 1x1 JPEG header and template for fallback or dynamic SVG/JPEG frames
function createSvgFrame(tick) {
  const time = new Date().toLocaleTimeString();
  const alt = (85 + Math.sin(tick * 0.1) * 3).toFixed(1);
  const spd = (6.4 + Math.cos(tick * 0.1) * 0.8).toFixed(1);
  const bat = Math.max(20, Math.round(78 - (tick * 0.01)));
  const roll = (Math.sin(tick * 0.05) * 5).toFixed(1);

  // Simulated bounding box positions
  const b1_x = 240 + Math.sin(tick * 0.04) * 80;
  const b1_y = 150 + Math.cos(tick * 0.03) * 40;
  const b2_x = 420 + Math.cos(tick * 0.05) * 60;
  const b2_y = 260 + Math.sin(tick * 0.04) * 30;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <defs>
      <linearGradient id="terrain" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#141c2b"/>
        <stop offset="50%" stop-color="#1b253b"/>
        <stop offset="100%" stop-color="#0f1724"/>
      </linearGradient>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(68,83,224,0.12)" stroke-width="1"/>
      </pattern>
    </defs>
    <!-- Ground Terrain Background -->
    <rect width="640" height="360" fill="url(#terrain)"/>
    <rect width="640" height="360" fill="url(#grid)"/>

    <!-- Waterway / River simulated feature -->
    <path d="M -20 180 Q 200 ${160 + Math.sin(tick*0.05)*15} 400 ${220 + Math.cos(tick*0.05)*10} T 660 200" fill="none" stroke="#2563eb" stroke-width="28" opacity="0.35"/>
    <path d="M -20 180 Q 200 ${160 + Math.sin(tick*0.05)*15} 400 ${220 + Math.cos(tick*0.05)*10} T 660 200" fill="none" stroke="#38bdf8" stroke-width="14" opacity="0.45"/>

    <!-- Waste Detection Box 1 -->
    <g transform="translate(${b1_x}, ${b1_y})">
      <rect x="0" y="0" width="70" height="50" fill="rgba(59,130,246,0.18)" stroke="#3b82f6" stroke-width="2"/>
      <rect x="0" y="-18" width="85" height="18" fill="#3b82f6"/>
      <text x="4" y="-5" fill="#ffffff" font-family="monospace" font-size="10" font-weight="bold">PLASTIC 94%</text>
    </g>

    <!-- Waste Detection Box 2 -->
    <g transform="translate(${b2_x}, ${b2_y})">
      <rect x="0" y="0" width="60" height="45" fill="rgba(16,185,129,0.18)" stroke="#10b981" stroke-width="2"/>
      <rect x="0" y="-18" width="75" height="18" fill="#10b981"/>
      <text x="4" y="-5" fill="#ffffff" font-family="monospace" font-size="10" font-weight="bold">CAN/ALU 88%</text>
    </g>

    <!-- Drone Crosshairs & Artificial Horizon -->
    <g transform="translate(320, 180) rotate(${roll})">
      <!-- Horizon lines -->
      <line x1="-80" y1="0" x2="-25" y2="0" stroke="rgba(255,255,255,0.7)" stroke-width="2"/>
      <line x1="25" y1="0" x2="80" y2="0" stroke="rgba(255,255,255,0.7)" stroke-width="2"/>
      <circle cx="0" cy="0" r="16" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/>
      <circle cx="0" cy="0" r="3" fill="#ef4444"/>
      <!-- Pitch ladder -->
      <line x1="-30" y1="-25" x2="30" y2="-25" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
      <line x1="-30" y1="25" x2="30" y2="25" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
    </g>

    <!-- Top Left: Drone System HUD -->
    <g transform="translate(20, 25)" font-family="monospace" font-size="12" fill="#22c55e">
      <text x="0" y="0">● LIVE FEED · DRONE-01 · 4K UHD</text>
      <text x="0" y="16" fill="rgba(255,255,255,0.85)">ALT: ${alt}m AGL | SPD: ${spd}m/s</text>
      <text x="0" y="32" fill="rgba(255,255,255,0.85)">BAT: ${bat}% (24.8V) | SAT: 18 (3D FIX)</text>
    </g>

    <!-- Top Right: AI Detection HUD -->
    <g transform="translate(500, 25)" font-family="monospace" font-size="12" fill="#38bdf8" text-anchor="end">
      <text x="120" y="0">AI ENGINE: ECO-YOLOv9</text>
      <text x="120" y="16" fill="#10b981">INFERENCE: 18.2ms (55 FPS)</text>
      <text x="120" y="32" fill="rgba(255,255,255,0.7)">TIME: ${time}</text>
    </g>

    <!-- Bottom Center: Compass / Heading -->
    <g transform="translate(320, 340)" font-family="monospace" font-size="11" fill="rgba(255,255,255,0.8)" text-anchor="middle">
      <rect x="-80" y="-16" width="160" height="20" fill="rgba(0,0,0,0.6)" rx="4"/>
      <text x="0" y="-2">HDG: 142° SE | PITCH: -45°</text>
    </g>
  </svg>`;
}

// Route to get single live frame
router.get('/video_feed/snapshot', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(createSvgFrame(Date.now() / 100));
});

// Route for continuous MJPEG/SVG live feed stream
router.get('/video_feed', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=--frame');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'close');
  res.setHeader('Pragma', 'no-cache');

  let tick = 0;
  const interval = setInterval(() => {
    tick++;
    const svg = createSvgFrame(tick);
    try {
      res.write(`--frame\r\n`);
      res.write(`Content-Type: image/svg+xml\r\n`);
      res.write(`Content-Length: ${Buffer.byteLength(svg)}\r\n\r\n`);
      res.write(svg);
      res.write(`\r\n`);
    } catch (e) {
      clearInterval(interval);
    }
  }, 100); // 10 FPS stream

  req.on('close', () => {
    clearInterval(interval);
  });
});

module.exports = router;
