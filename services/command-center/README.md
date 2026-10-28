# EcoWing Command Center: Full-Stack Architecture & Deployment Guide

This package deploys the complete EcoWing Command Center: a static frontend dashboard served by nginx, a Node.js + Express + Socket.IO backend, and a MongoDB database for storing detection events, drone telemetry logs, and fleet state.

```
EcoWing/
├── backend/
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
├── index.html              # Hardened command center dashboard
├── config.js               # Per-environment frontend settings
├── docker-compose.yml          # Complete stack: web (nginx) + backend (Node) + mongodb (Mongo 7)
├── Dockerfile                  # Web frontend container
├── nginx.conf                  # Security headers, CSP, /api and /socket.io reverse proxy
└── README.md
```

---

## 1. Stack Overview

- **MongoDB Database**: Holds collections for `detections`, `telemetries`, and `drones`. Kept clean and empty by default until a drone connects and streams live data.
- **Node.js + Express Backend**: Provides all REST APIs expected by the dashboard and listens for commands.
- **Socket.IO v4 Server**: Handles low-latency real-time telemetry updates, new detection broadcasts, and command verification.
- **MJPEG Camera Stream (`/video_feed`)**: Distributes live video frames from the drone to web clients. Serves a clean standby stream when no drone is transmitting.
- **Hardened Nginx Frontend**: Reverse proxies `/api/` and `/socket.io/` to the backend and serves the frontend dashboard with strict security headers.

---

## 2. Running with Docker Compose (Recommended)

Start the entire stack (MongoDB, Backend, and Frontend) with a single command:

```bash
docker compose up -d --build
```

- **Frontend Dashboard**: `http://localhost:8080`
- **Backend API**: `http://localhost:3000/api`
- **MongoDB**: `localhost:27017`

---

## 3. Database Configuration (MongoDB Atlas or Local)

### Using MongoDB Atlas:
1. Log in to [MongoDB Atlas](https://cloud.mongodb.com) and create or select your cluster.
2. In **Database Access**, create a database user and note the password.
3. In **Network Access**, ensure your IP address is whitelisted (or `0.0.0.0/0` for cloud deployment).
4. Click **Connect** → **Drivers** (Node.js) and copy the connection string.
5. In `backend/.env`, paste your Atlas URI:
   ```env
   PORT=3000
   MONGO_URI=mongodb+srv://<username>:<password>@<cluster-url>/ecowing?retryWrites=true&w=majority
   ```

### Start the Backend:
```bash
cd backend
npm install
npm start
```

### Open the Dashboard:
Open `index.html` in your browser, or serve it using any HTTP server:
```bash
npx serve .
```

---

## 4. Connecting a Drone to Stream & Store Data

When your physical or edge drone connects, it streams telemetry, camera frames, and waste detections into the backend, which stores them in MongoDB and broadcasts them live to the dashboard:

### A. Stream Live Telemetry (1–2 Hz)
**POST** `http://<backend-ip>:3000/api/drone/telemetry`
```json
{
  "drone_id": "Drone-01",
  "status": "Flying",
  "battery_pct": 82.5,
  "battery_voltage": 7.95,
  "altitude_m": 45.2,
  "speed_mps": 6.1,
  "imu_temp_c": 33.1,
  "gimbal_pitch_deg": -45,
  "wind_speed_mps": 4.5,
  "satellites": 18,
  "heading_deg": 142,
  "lat": 40.7250,
  "lng": -73.9790,
  "flight_time_s": 420,
  "mission": "Site 3 - Area Scan"
}
```

### B. Record a Waste Detection
**POST** `http://<backend-ip>:3000/api/drone/detection`
```json
{
  "drone_id": "Drone-01",
  "class_name": "plastic_bottle",
  "confidence": 0.94,
  "center": [320, 240]
}
```
*Stored immediately in MongoDB, appears in the Live Feed and Analytics Tab, and updates the stats card.*

### C. Stream Camera Frames
**POST** `http://<backend-ip>:3000/api/drone/stream-frame`
- Body: raw binary JPEG image (`Content-Type: image/jpeg`) or JSON `{ "frame": "<base64_jpeg>" }`
- Broadcasts in real-time to all browsers viewing `/video_feed`.

---

## 5. API Endpoints Reference

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/stats` | Dashboard metrics (unique count, tracks, FPS, class counts) |
| `GET` | `/api/events` | List of waste detections (last 200, newest first) |
| `POST` | `/api/feed/clear` | Clears detections from MongoDB |
| `GET` | `/api/chart_data` | Class aggregations for bar and doughnut charts |
| `GET` | `/api/telemetry` | Active drone telemetry and fleet status |
| `POST` | `/api/drone/select` | Sets active drone |
| `POST` | `/api/drone/command` | Sends command (`start`, `hold`, `rth`, `land`) to drone |
| `POST` | `/api/camera/command` | Controls camera (`photo`, `record`, `zoom`, `track`) |
| `GET` | `/api/export/csv` | Downloads all stored detections as CSV |
| `GET` | `/api/export/json` | Downloads all stored detections as JSON |
| `GET` | `/video_feed` | Live MJPEG camera feed |
