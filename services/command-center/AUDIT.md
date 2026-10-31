# EcoWing Drone Fleet Command Center — Security, Safety & Integration Audit

**Date:** 2026-11-01  
**Repository:** `EcoWing` (`github.com/dhairya-wate/EcoWing`)  
**Workspace Path:** `C:\Users\Anshu\Desktop\mini-project\EcoWing`  
**Target Architecture:** Nginx frontend proxy, Express/Node.js + Socket.IO command center backend, MongoDB telemetry & detection database. Controls autonomous drones.

---

## Executive Summary

An audit of the EcoWing repository identified critical physical safety and access control vulnerabilities. Because this backend directly commands airborne drones (`start`, `hold`, `rth`, `land`, `estop`), missing authentication and unvalidated command ingestion present immediate flight-safety hazards. In addition, unprotected database ports, lack of rate limiting on frame uploads, unbounded telemetry accumulation, and unauthenticated ingestion routes leave the command center vulnerable to spoofing, denial of service, and command injection.

---

## Audit Findings Matrix

| ID | Category | Severity | Status | File(s) & Lines | Title / Issue |
|---|---|---|---|---|---|
| **E1** | Safety/Security | **CRITICAL** | **CONFIRMED** | `backend/routes/api.js:260-379` | Unauthenticated Drone Command Endpoints (`/command`, `/select`, `/camera/command`) |
| **E2** | Safety/Security | **HIGH** | **CONFIRMED** | `backend/routes/drone.js:54-322`, `backend/server.js:32-127` | Unauthenticated Ingestion Routes (`/telemetry`, `/detection`, `/stream-frame`, Socket.IO) |
| **E3** | Security | **HIGH** | **CONFIRMED** | `backend/routes/api.js:144-168, 385-428` | Unauthenticated Data Purge & Exfiltration (`/feed/clear`, `/export/csv`, `/export/json`) |
| **E4** | Security | **HIGH** | **CONFIRMED** | `docker-compose.yml:27`, `backend/server.js:179` | MongoDB Port 27017 Published to Host with Insecure Default Credentials |
| **E5** | Security | **MEDIUM** | **CONFIRMED** | `docker-compose.yml:15-16` | Backend Port 3000 Published Directly (Bypasses Nginx Security Headers) |
| **E6** | Correctness/Safety | **HIGH** | **CONFIRMED** | `backend/routes/drone.js:154-245`, `backend/routes/api.js:303-356` | Missing Payload Schema Validation (Coordinates, Battery, Flight Status, Commands) |
| **E7** | Reliability | **MEDIUM** | **CONFIRMED** | `backend/app.js:23-30`, `backend/routes/drone.js:304-322` | Unbounded Body Size (20 MB) & Missing Rate Limits on Ingestion |
| **E8** | Reliability | **MEDIUM** | **CONFIRMED** | `backend/models/Telemetry.js:70-78` | Telemetry Stored Indefinitely Without TTL Expiration Index |
| **E9** | Safety | **HIGH** | **CONFIRMED** | `backend/routes/api.js:303-356` | Missing Command Acknowledgement, Command IDs & Failsafe Guards |
| **E10** | Infrastructure | **LOW** | **CONFIRMED** | `docker-compose.yml:9-22` | Compose `depends_on` Missing Service Healthchecks (`condition: service_healthy`) |
| **E11** | Maintenance | **LOW** | **CONFIRMED** | `docker-compose.yml:25`, `backend/package.json` | Unpinned Minor Version for MongoDB (`mongo:7-jammy`) & Undeclared Node Engine |
| **E12** | Documentation | **LOW** | **CONFIRMED** | `README.md:74-77, 86, 108` | Contradictory Run Instructions Bypassing Nginx Reverse Proxy |
| **E13** | Governance | **LOW** | **CONFIRMED** | Root directory | Missing Root `.env.example`, LICENSE, Automated Test Suite & CI Pipelines |
| **I1** | Integration | **HIGH** | **CONFIRMED** | `Detection/app.py`, `EcoWing/backend/routes/drone.js` | Missing Server-to-Server Ingestion Bridge Between Detection & EcoWing |
| **I2** | Integration | **HIGH** | **CONFIRMED** | `config.py` vs `Detection.js` vs `index.html` | Schema and Taxonomy Name Divergence (Snake Case vs Title Case vs COCO) |
| **I3** | Architecture | **MEDIUM** | **CONFIRMED** | `EcoWing/index.html` vs `Detection/public/index.html` | Conflicting Canonical Dashboards |
| **I4** | Architecture | **HIGH** | **CONFIRMED** | `Detection/app.py:55` vs `EcoWing/routes/api.js:19` | In-Memory Frame Counts vs Persistent Cumulative Analytics Discrepancy |
| **I5** | Security | **HIGH** | **CONFIRMED** | `Detection/app.py`, `EcoWing/backend/routes/drone.js` | Lack of Unified Device Authentication Model for Detection Streamer |
| **E-NEW1** | Security | **HIGH** | **NEW** | `backend/server.js:13-20`, `backend/app.js:19` | Wildcard CORS on Socket.IO and Express Application |
| **E-NEW2** | Security | **HIGH** | **NEW** | `backend/routes/api.js:317-326` | Persistent Unsanitized Command String Injection in MongoDB State |

---

## Detailed Findings

### E1. Unauthenticated Drone Command Endpoints
- **Repo & File:** `EcoWing`, `backend/routes/api.js:260-379`
- **Severity:** **CRITICAL**
- **Status:** **CONFIRMED**
- **Evidence:**
  ```javascript
  router.post('/drone/command', async (req, res) => {
    const { command, drone_id } = req.body;
    ...
    io.to(`drone:${drone_id}`).emit('command', { command });
  ```
  Anyone with network access to the API can send `start`, `hold`, `rth`, or `land` commands to physical drones. There is no session token, operator password, API key, or authentication check. An unauthorized attacker could force a drone to start motors or prematurely land in an unsafe environment.

---

### E2. Unauthenticated Ingestion Routes & WebSockets
- **Repo & File:** `EcoWing`, `backend/routes/drone.js:54-322`, `backend/server.js:32-127`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  - `POST /api/drone/telemetry`: Accepts arbitrary GPS, battery, and altitude values without verifying the identity of the transmitting drone.
  - `POST /api/drone/detection`: Allows any source to insert fake waste detections into the database.
  - `POST /api/drone/stream-frame`: Allows unauthenticated video frame injection.
  - Socket.IO handlers `drone:telemetry`, `drone:detection`, and `drone:frame` perform no authentication handshake.

---

### E3. Unauthenticated Data Purge & Exfiltration Endpoints
- **Repo & File:** `EcoWing`, `backend/routes/api.js:144-168` (`/api/feed/clear`), `backend/routes/api.js:385-428` (`/export/csv`, `/export/json`)
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  `POST /api/feed/clear` performs `Detection.deleteMany({})` and resets the store without requiring operator credentials. Similarly, `GET /api/export/csv` and `GET /api/export/json` permit unauthenticated exfiltration of all historical flight and waste detection records.

---

### E4. MongoDB Port 27017 Published to Host with Insecure Default
- **Repo & File:** `EcoWing`, `docker-compose.yml:27`, `backend/server.js:179`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  In `docker-compose.yml`:
  ```yaml
  mongodb:
    image: mongo:7-jammy
    ports:
      - "27017:27017"
  ```
  Publishing port 27017 exposes the database to the host interface and external LAN. Combined with the default `MONGO_URI: mongodb://mongodb:27017/ecowing` without a username/password, any host on the network can directly query or tamper with the database.

---

### E5. Backend Port 3000 Published Directly (Bypasses Nginx)
- **Repo & File:** `EcoWing`, `docker-compose.yml:15-16`
- **Severity:** **MEDIUM**
- **Status:** **CONFIRMED**
- **Evidence:**
  `docker-compose.yml` maps `3000:3000` for the backend service while simultaneously running nginx on `8080:8080`. Clients can directly target port 3000, bypassing nginx security headers (CSP, HSTS, X-Frame-Options) and reverse-proxy rate limits.

---

### E6. Missing Payload Schema Validation
- **Repo & File:** `EcoWing`, `backend/routes/drone.js:154-245`, `backend/routes/api.js:303-356`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  Payload inputs are trusted blindly:
  - `lat` / `lng`: No bounds check (`-90 <= lat <= 90`, `-180 <= lng <= 180`).
  - `battery_pct`: Allows negative numbers or out-of-range values in REST routes.
  - `status`: No enum validation in drone REST ingestion.
  - `center`: Does not validate that coordinates fall within camera frame boundaries.

---

### E7. Unbounded Request Body Size & Missing Rate Limiting
- **Repo & File:** `EcoWing`, `backend/app.js:23-30`, `backend/routes/drone.js:304-322`
- **Severity:** **MEDIUM**
- **Status:** **CONFIRMED**
- **Evidence:**
  `backend/app.js` permits up to `20mb` for all JSON and raw bodies. There is no rate limiter on `POST /stream-frame` or `/api/drone/telemetry`. An attacker can flood 20MB requests, exhausting memory and choking network sockets.

---

### E8. Telemetry Stored Forever Without TTL Index
- **Repo & File:** `EcoWing`, `backend/models/Telemetry.js:70-78`
- **Severity:** **MEDIUM**
- **Status:** **CONFIRMED**
- **Evidence:**
  High-frequency telemetry (1–2 pings/sec per active drone) is stored in the `telemetries` collection indefinitely without a TTL index on `createdAt` or `timestamp`. Over weeks of flight operations, disk space will continuously fill until the database crashes.

---

### E9. Missing Command Acknowledgement, Command IDs & Safety Guards
- **Repo & File:** `EcoWing`, `backend/routes/api.js:303-356`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  Commands do not carry unique idempotency IDs (`command_id`) and do not await confirmation/acknowledgement from the drone autopilot. If a drone's telemetry link is lost or stale (e.g. last seen 10 minutes ago, or battery critical), the backend still accepts and broadcasts flight commands without failsafe verification.

---

### E10. Compose `depends_on` Missing Service Healthchecks
- **Repo & File:** `EcoWing`, `docker-compose.yml:9-22`
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  `depends_on: [mongodb]` and `depends_on: [backend]` only wait for container startup, not service readiness. If Node starts before MongoDB finishes socket initialization, early queries fail.

---

### E11. Unpinned MongoDB Tag & Undeclared Node Version
- **Repo & File:** `EcoWing`, `docker-compose.yml:25`, `backend/package.json`
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  `mongo:7-jammy` is a moving target subject to breaking upstream changes. `backend/package.json` lacks an `engines` definition pinning the required Node.js runtime.

---

### E12. Contradictory Run Instructions in README
- **Repo & File:** `EcoWing`, `README.md:74-77, 86, 108`
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  The README suggests running `npx serve .` to view `index.html`, which bypasses nginx's CSP and reverse proxy routes. It also instructs drone companion computers to post directly to port 3000 instead of port 8080.

---

### E13. Missing Governance & Test Infrastructure
- **Repo & File:** `EcoWing` root
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  There is no root `.env.example`, no LICENSE file, no automated unit/integration test suite, and no CI/CD configuration.

---

### I1. Missing Ingestion Bridge Between Detection and EcoWing
- **Repo & File:** `Detection/app.py`, `EcoWing/backend/routes/drone.js`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  Detection's Python server (`app.py`) runs YOLO inference but has **no code** that pushes detection events to EcoWing's `POST /api/drone/detection`. The two backend services run completely disconnected.

---

### I2. Schema and Taxonomy Divergence
- **Repo & File:** `Detection/config.py`, `Detection/detector.py`, `EcoWing/backend/models/Detection.js`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  - EcoWing expects snake_case class names (e.g., `plastic_bottle`, `paper`) and strictly validates `material_type` against `['Recyclable', 'Biodegradable', 'Non-Recyclable']`.
  - Detection outputs verbose titles (e.g., `"Plastic Waste"`, `"Bottle (Plastic/Glass)"`, `"Paper / Booklet Waste"`) with confidence in `0-100` rather than `0-1`.
  - Without a canonical taxonomy schema, direct payload transfer leads to validation rejections.

---

### I3. Conflicting Canonical Dashboards
- **Repo & File:** `EcoWing/index.html` vs `Detection/public/index.html`
- **Severity:** **MEDIUM**
- **Status:** **CONFIRMED**
- **Evidence:**
  Both repositories host their own web dashboards claiming to be the primary interface for EcoWing. The architecture must formally designate `EcoWing/index.html` as the primary drone command & analytics center, and `Detection/public/index.html` as the local camera configuration & testing utility.

---

### I4. In-Memory Frame Counts vs Persistent Cumulative Analytics
- **Repo & File:** `Detection/app.py:55` vs `EcoWing/backend/routes/api.js:19`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  Detection's `/api/detections` returns instantaneous counts of objects in the single most recent video frame. EcoWing's `/api/stats` returns historical cumulative unique detections over the entire mission. Conflating the two creates conflicting metrics.

---

### I5. Lack of Unified Device Authentication Model
- **Repo & File:** `Detection/app.py`, `EcoWing/backend/routes/drone.js`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  EcoWing needs an ingestion auth token (`ECOWING_DEVICE_TOKEN`) to authenticate incoming telemetry and detections, and Detection must be configured with this token to authenticate its push requests.

---

### E-NEW1. Wildcard CORS on Socket.IO & Express Application
- **Repo & File:** `EcoWing`, `backend/server.js:15-18`, `backend/app.js:19`
- **Severity:** **HIGH**
- **Status:** **NEW**
- **Evidence:**
  ```javascript
  const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
  app.use(cors());
  ```
  Permitting `origin: '*'` on the command center's Socket.IO server allows any malicious webpage visited in an operator's browser to connect, receive real-time drone telemetry, and eavesdrop on fleet movements.

---

### E-NEW2. Persistent Unsanitized Command String Injection
- **Repo & File:** `EcoWing`, `backend/routes/api.js:317-326`
- **Severity:** **HIGH**
- **Status:** **NEW**
- **Evidence:**
  In `POST /api/drone/command`:
  ```javascript
  const newStatus = commandStatusMap[command.toLowerCase()] || command;
  await Drone.findOneAndUpdate({ drone_id }, { status: newStatus, 'telemetry.status': newStatus });
  ```
  If an attacker sends an arbitrary string (e.g. HTML or script payloads), it is stored directly in MongoDB and broadcast to all connected dashboard clients via `telemetry_update`.

