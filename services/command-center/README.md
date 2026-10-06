# 🦅 EcoWing — Autonomous Waste-Detection Drone Fleet Command Center

> Complete command center for autonomous waste-detection drone fleets featuring live video HUD streaming, mission planning, site analytics, real-time telemetry, and a full **MongoDB database architecture**.

---

## 📦 MongoDB Database Architecture

EcoWing is powered by **MongoDB** with **Mongoose ODM**. It provides a schema-enforced, indexed, and scalable data layer for aerial autonomous robotics and environmental analytics.

### Collections & Mongoose Schemas

| Collection | Model File | Description | Key Indexes |
|---|---|---|---|
| `users` | [`models/User.js`](file:///c:/Users/Anshu/Desktop/EcoWing/models/User.js) | Operator accounts, roles (`admin`, `pilot`, `analyst`), bcrypt password hashing, and user preferences | `username` (unique), `email` (unique) |
| `drones` | [`models/Drone.js`](file:///c:/Users/Anshu/Desktop/EcoWing/models/Drone.js) | Fleet aircraft records, live battery voltage, signal, flight hours, PTZ camera states, and real-time telemetry | `drone_id` (unique), `status` |
| `detections` | [`models/Detection.js`](file:///c:/Users/Anshu/Desktop/EcoWing/models/Detection.js) | AI waste detection events (Plastic Bottles, Bags, Cans, Glass, etc.), confidence scores, bounding boxes | `event_id` (unique), `location` (`2dsphere` GeoJSON), `createdAt` |
| `missions` | [`models/Mission.js`](file:///c:/Users/Anshu/Desktop/EcoWing/models/Mission.js) | Flight survey routes, waypoint coordinates (lat/lng/alt), estimated burn rate and duration | `mission_id` (unique), `status` |
| `telemetrylogs` | [`models/TelemetryLog.js`](file:///c:/Users/Anshu/Desktop/EcoWing/models/TelemetryLog.js) | High-frequency time-series telemetry sensor logs for path replay and battery burn analysis | Compound: `{ drone_id: 1, timestamp: -1 }` |
| `systemconfigs` | [`models/SystemConfig.js`](file:///c:/Users/Anshu/Desktop/EcoWing/models/SystemConfig.js) | Global geofence limits, AI vision threshold configurations, and fleet parameters | `key` (unique) |

---

## 🚀 Quick Start Guide

### 1. Configure MongoDB Connection

In [`.env`](file:///c:/Users/Anshu/Desktop/EcoWing/.env), specify your MongoDB connection string:

```env
PORT=5000
MONGODB_URI=mongodb://127.0.0.1:27017/ecowing
JWT_SECRET=ecowing_drone_fleet_super_secret_jwt_key_2026
SIMULATE_LIVE_DETECTIONS=true
```

#### Options:
- **Local MongoDB**: Run `net start MongoDB` on Windows, or start `mongod`.
- **MongoDB Atlas (Free Cloud)**: Replace `MONGODB_URI` with your Atlas connection string:
  ```env
  MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/ecowing?retryWrites=true&w=majority
  ```

### 2. Verify Database Connection

Run the built-in database diagnostics tool:
```bash
npm run db:check
```

### 3. Database Maintenance & Reset
- **Clean / Production Reset** (purges all simulated/false detections):
  ```bash
  npm run db:clean
  ```
- **Seed Demo Data** (optional dev testing):
  ```bash
  npm run seed
  ```

**Default Admin Credentials:**
- **Username**: `admin`
- **Password**: `ecowing123`

---

## 🚢 Deployment & Production Readiness

EcoWing is fully preconfigured for modern cloud hosting platforms:

### 1. Render / Railway / Heroku
- A [`Procfile`](file:///c:/Users/Anshu/Desktop/EcoWing/Procfile) is provided: `web: node server.js`.
- A [`render.yaml`](file:///c:/Users/Anshu/Desktop/EcoWing/render.yaml) blueprint is included for 1-click deployment on Render.
- Add `MONGODB_URI` and `JWT_SECRET` in your dashboard environment variables.

### 2. Docker / Cloud Run / Kubernetes
A production-optimized [`Dockerfile`](file:///c:/Users/Anshu/Desktop/EcoWing/Dockerfile) and [`.dockerignore`](file:///c:/Users/Anshu/Desktop/EcoWing/.dockerignore) are included:
```bash
docker build -t ecowing-command-center .
docker run -p 5000:5000 -e MONGODB_URI="<your_atlas_uri>" ecowing-command-center
```

### 4. Start the Application

```bash
npm start
```
Visit **[http://localhost:5000](http://localhost:5000)** in your browser.

---

## 📡 REST API & Socket.io Endpoints

### Authentication (`/api/auth`)
- `POST /api/auth/register` — Create a new operator account in MongoDB
- `POST /api/auth/login` — Authenticate credentials against MongoDB & generate JWT
- `POST /api/auth/reset-password` — Update account password in MongoDB
- `GET /api/auth/me` — Retrieve current authenticated user profile
- `PUT /api/auth/profile` — Update operator profile and settings in MongoDB

### Fleet & Commands (`/api/drone`)
- `GET /api/drones` — List all drones in the fleet
- `POST /api/drones` — Register a new drone
- `POST /api/drone/select` — Set active aircraft
- `POST /api/drone/command` — Issue flight commands (`start`, `hold`, `rth`, `land`)

### Waste Detection & Site Analytics (`/api`)
- `GET /api/events` — Retrieve live detection events list
- `POST /api/events` — Ingest a new detection event and broadcast via Socket.io
- `POST /api/feed/clear` — Clear / archive detection feed
- `GET /api/stats` — MongoDB aggregation pipeline of waste counts, active tracks, and telemetry
- `GET /api/chart_data` — Categorical breakdown for Chart.js bar and doughnut charts

### Mission Waypoints & Telemetry
- `GET /api/missions` / `POST /api/missions` — Autonomous survey planning
- `GET /api/telemetry` — Live sensor telemetry table
- `GET /api/export/csv` — Export MongoDB detection database to CSV
- `GET /api/export/json` — Export MongoDB detection database to JSON
- `GET /video_feed` — Real-time simulated camera feed with AI bounding boxes & HUD overlay

---

## 🛡️ Built-in Resilience & Offline Fallback

The backend includes automatic reconnection handling:
- If MongoDB is momentarily unreachable, the server logs clear setup tips and uses a safe in-memory cache so the application remains responsive.
- As soon as your MongoDB service or Atlas cluster is online, the server reconnects automatically without restarting!
