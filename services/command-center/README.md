# EcoWing Command Center: Full-Stack Architecture & Deployment Guide

This package deploys the complete EcoWing Command Center: a static frontend dashboard served by nginx, a Node.js + Express + Socket.IO backend, and a MongoDB database for storing detection events, drone telemetry logs, and fleet state.

```
EcoWing/
├── backend/
│   ├── middleware/
│   │   └── auth.js             # Operator and per-drone device token verification (E1, E2, E3)
│   ├── models/
│   │   ├── Detection.js        # Mongoose schema for waste detection events
│   │   ├── Drone.js            # Mongoose schema for fleet drones & active status
│   │   └── Telemetry.js        # Mongoose schema for GPS, battery & sensor history
│   ├── routes/
│   │   ├── api.js              # Dashboard REST endpoints (/stats, /events, /chart_data, /telemetry, etc.)
│   │   └── drone.js            # Ingestion endpoints for connected drones (/telemetry, /detection, /stream-frame)
│   ├── server.js               # Express + Socket.IO server + MongoDB connection
│   ├── videoStream.js          # MJPEG live camera stream distributor (/video_feed)
│   ├── Dockerfile              # Backend container definition
│   └── package.json            # Node.js dependencies
├── index.html                  # Hardened command center dashboard
├── config.js                   # Per-environment frontend settings
├── docker-compose.yml          # Hardened stack: web (nginx) + backend (Node) + mongodb (Mongo 7)
├── Dockerfile                  # Web frontend container
├── nginx.conf                  # Security headers, CSP, /api and /socket.io reverse proxy
└── README.md
```

---

## 1. Stack Overview & Security Architecture

- **Canonical Deployment:** The EcoWing Command Center dashboard runs locally behind Nginx (port `8080`).
- **Remote Access via VPN:** Remote operators connecting from outside the local network must use an encrypted VPN (such as WireGuard or Tailscale). The backend port (3000) and MongoDB (27017) are strictly internal to the Docker network and must not be exposed to the host or public internet.
- **Operator Authentication (`ECOWING_OPERATOR_TOKEN`):** Sensitive operations (`POST /api/drone/connect`, `POST /api/drone/command`, `POST /api/camera/command`, `POST /api/drone/select`, `POST /api/feed/clear`, `GET /api/export/csv`, `GET /api/export/json`) strictly require the operator token in the `X-Operator-Token` header. Startup validation enforces a minimum of 32 characters, 12 unique characters, and non-repeating entropy.
- **E2 Ingestion Auth (Per-Drone Device Token):** Drone telemetry (`POST /api/drone/telemetry`), detections (`POST /api/drone/detection`), and camera frames (`POST /api/drone/stream-frame`) strictly require a per-drone device token in `X-Drone-Token` or `Authorization: Bearer <token>`. Configured strictly via environment variables (`DRONE_DEVICE_TOKENS` or `DRONE_TOKEN_<DRONE_ID>`) and verified using constant-time cryptographic comparison (`crypto.timingSafeEqual`). A token issued for Drone A cannot post as Drone B.
- **Target Address Allowlist (`DRONE_TARGET_ALLOWLIST`) & Anti-SSRF:** The "Connect Drone" target address is strictly checked against the `DRONE_TARGET_ALLOWLIST` environment variable (default: empty, strict deny-all). All hostnames are resolved, every returned address is checked against the allowlist (preventing DNS rebinding attacks), and HTTP connections are made directly to the verified IP with redirects strictly disabled.
- **LAN Drone Target Protocol Restriction:** Target URLs are restricted to unencrypted HTTP (`http://`). HTTPS targets are rejected because internal/LAN IP addresses do not have publicly-trusted TLS certificates, avoiding TLS handshake failures and MITM vulnerabilities.
- **E1 Drone & Camera Command Sanitization:** Drone commands are strictly restricted to `start`, `hold`, `rth`, `land`. Camera commands are restricted to `photo`, `record`, `zoom`, `track` with strict type and numeric range checks (e.g. zoom: 1.0 to 10.0). `drone_id` identifiers are enforced to alphanumeric with hyphens/underscores (max 64 chars).
- **E2 Telemetry Bounds Validation:** Ingested drone telemetry (`POST /api/drone/telemetry`) strictly validates numeric bounds for coordinates (latitude [-90, 90], longitude [-180, 180]), battery [0, 100]%, altitude [-100, 10000]m, speed [0, 100]m/s, and heading [0, 360]deg. Malformed or out-of-bounds telemetry is rejected with HTTP 400.
- **E4/E5 Network Exposure Hardening:** In `docker-compose.yml`, host port mappings for `27017` and `3000` have been removed. Root MongoDB credentials and operator tokens are required from environment variables with no default (`${MONGO_INITDB_ROOT_USERNAME:?required}`, `${MONGO_INITDB_ROOT_PASSWORD:?required}`, `${MONGO_URI:?required}`, `${ECOWING_OPERATOR_TOKEN:?required}`).
- **Nginx-to-Detection Path Status:** **UNVERIFIED** (Docker is unavailable on test environment). If deploying on a Docker host, verify using `wget`:
  ```bash
  docker compose exec web wget -qO- --header="X-Operator-Token: $DETECTION_OPERATOR_TOKEN" http://host.docker.internal:5000/api/system_info
  ```
- **Vercel Frontend Demo Notice:** The public Vercel frontend deployment (`https://eco-wing-7pua.vercel.app`) is an unlinked, static demonstration preview only. It is not connected to the local backend, and browsers block HTTPS-to-HTTP local network connections as Mixed Content.

---

## 2. Running with Docker Compose (Recommended)

Start the stack with environment variables set:

```bash
export MONGO_INITDB_ROOT_USERNAME=ecowing_admin
export MONGO_INITDB_ROOT_PASSWORD=your_secure_mongo_password
export MONGO_URI="mongodb://ecowing_admin:your_secure_mongo_password@mongodb:27017/ecowing?authSource=admin"
export ECOWING_OPERATOR_TOKEN="your_secure_operator_token_min_32_chars"
export DRONE_DEVICE_TOKENS='{"Drone-01":"your_drone_device_token_min_32_chars"}'

docker compose up -d --build
```

- **Frontend Dashboard**: `http://localhost:8080` (reverse-proxies to backend and Detection)
- **Backend API**: Internal container network `http://backend:3000` (not published to host)
- **MongoDB**: Internal container network `mongodb:27017` (not published to host)

---

## 3. Database Configuration (MongoDB Atlas or Local)

In `backend/.env`, configure your environment:
```env
PORT=3000
MONGO_URI=mongodb+srv://<username>:<password>@<cluster-url>/ecowing?retryWrites=true&w=majority
ECOWING_OPERATOR_TOKEN=replace_with_min_32_chars_token
DRONE_DEVICE_TOKENS={"Drone-01":"drone_secret_token_alpha_1234567890"}
DRONE_TARGET_ALLOWLIST=192.0.2.10
```

### Start the Backend Locally:
```bash
cd backend
npm install
npm start
```

---

## 4. Connecting a Drone to Stream & Store Data

When your drone connects, it streams telemetry, camera frames, and waste detections using its per-drone device token:

### A. Stream Live Telemetry (1–2 Hz)
**POST** `http://<backend-ip>:3000/api/drone/telemetry`
Headers:
- `Content-Type: application/json`
- `X-Drone-Token: <DRONE_DEVICE_TOKEN>`

```json
{
  "drone_id": "Drone-01",
  "status": "Flying",
  "battery_pct": 82.5,
  "battery_voltage": 7.95,
  "altitude_m": 45.2,
  "speed_mps": 6.1,
  "heading_deg": 142,
  "latitude": 40.7250,
  "longitude": -73.9790
}
```

### B. Record a Waste Detection
**POST** `http://<backend-ip>:3000/api/drone/detection`
Headers:
- `Content-Type: application/json`
- `X-Drone-Token: <DRONE_DEVICE_TOKEN>`

```json
{
  "drone_id": "Drone-01",
  "class_name": "plastic_bottle",
  "confidence": 0.94,
  "location": { "lat": 40.7250, "lng": -73.9790 }
}
```

### C. Stream Camera Frames
**POST** `http://<backend-ip>:3000/api/drone/stream-frame`
Headers:
- `Content-Type: application/json`
- `X-Drone-Token: <DRONE_DEVICE_TOKEN>`

```json
{
  "drone_id": "Drone-01",
  "frame": "<base64_jpeg>"
}
```

---

## 5. API Endpoints Reference

| Method | Route | Auth Header | Description |
|---|---|---|---|
| `GET` | `/api/stats` | Public | Dashboard metrics (unique count, tracks, FPS, class counts) |
| `GET` | `/api/events` | Public | List of waste detections (last 200, newest first) |
| `POST` | `/api/feed/clear` | `X-Operator-Token` | Clears detections from MongoDB (E3) |
| `GET` | `/api/chart_data` | Public | Class aggregations for bar and doughnut charts |
| `GET` | `/api/telemetry` | Public | Active drone telemetry and fleet status |
| `POST` | `/api/drone/select` | `X-Operator-Token` | Sets active drone |
| `POST` | `/api/drone/command` | `X-Operator-Token` | Sends flight command (`start`, `hold`, `rth`, `land`) (E1) |
| `POST` | `/api/camera/command` | `X-Operator-Token` | Controls camera (`photo`, `record`, `zoom`, `track`) (E1) |
| `GET` | `/api/export/csv` | `X-Operator-Token` | Downloads all stored detections as CSV (E3) |
| `GET` | `/api/export/json` | `X-Operator-Token` | Downloads all stored detections as JSON (E3) |
| `POST` | `/api/drone/connect` | `X-Operator-Token` | Connects or registers a drone with target allowlist validation |
| `POST` | `/api/drone/telemetry` | `X-Drone-Token` | Ingests live telemetry with coordinate & battery validation (E2) |
| `POST` | `/api/drone/detection` | `X-Drone-Token` | Ingests waste detection event (E2) |
| `POST` | `/api/drone/stream-frame` | `X-Drone-Token` | Ingests live camera frame (E2) |
| `GET` | `/video_feed` | Public | Live MJPEG camera feed |
