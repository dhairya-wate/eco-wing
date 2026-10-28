/**
 * EcoWing Video Feed Streamer (MJPEG)
 * Distributes live camera frames from connected drones to web dashboard clients.
 * When no drone is streaming, serves a standby frame.
 */

// Minimal valid 640x360 dark standby JPEG frame (base64 encoded)
// Shows a dark slate screen representing camera offline / standby
const STANDBY_FRAME_BASE64 = 
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////' +
  'wgALCAFoAoABAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const standbyBuffer = Buffer.from(STANDBY_FRAME_BASE64, 'base64');

// Set of active client HTTP response streams
const activeClients = new Set();
let latestFrame = null;
let lastFrameTime = 0;
let frameCount = 0;
let currentFps = 0.0;

// Calculate FPS periodically
setInterval(() => {
  currentFps = frameCount;
  frameCount = 0;
  // If no frame received in the last 3 seconds, reset latestFrame
  if (Date.now() - lastFrameTime > 3000) {
    latestFrame = null;
    currentFps = 0.0;
  }
}, 1000);

/**
 * Handle new client connection to /video_feed
 */
function handleClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'close',
    'Pragma': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });

  activeClients.add(res);

  // Send an initial frame immediately
  const initialFrame = latestFrame || standbyBuffer;
  sendFrameToClient(res, initialFrame);

  // If no drone is streaming, push standby frame every 2 seconds to keep connection alive
  const standbyInterval = setInterval(() => {
    if (!latestFrame && activeClients.has(res)) {
      sendFrameToClient(res, standbyBuffer);
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(standbyInterval);
    activeClients.delete(res);
  });
}

/**
 * Send a single JPEG frame to a single client
 */
function sendFrameToClient(res, buffer) {
  try {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
    res.write(buffer);
    res.write('\r\n');
  } catch (err) {
    activeClients.delete(res);
  }
}

/**
 * Ingest and broadcast a new frame from a drone
 * @param {Buffer} buffer - JPEG image buffer
 */
function broadcastFrame(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    if (typeof buffer === 'string') {
      buffer = Buffer.from(buffer.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } else {
      return;
    }
  }

  latestFrame = buffer;
  lastFrameTime = Date.now();
  frameCount++;

  // Broadcast to all connected clients
  for (const client of activeClients) {
    sendFrameToClient(client, buffer);
  }
}

function getStreamStats() {
  return {
    fps: currentFps,
    clientCount: activeClients.size,
    isStreaming: latestFrame !== null && (Date.now() - lastFrameTime < 2500)
  };
}

module.exports = {
  handleClient,
  broadcastFrame,
  getStreamStats
};

