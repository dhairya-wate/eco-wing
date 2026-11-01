# EcoWing Fleet Command Center: Full-Stack Architecture & Deployment Guide

The authoritative **Command and Control Center** for the EcoWing Autonomous Drone Fleet. It hosts the pilot dashboard, manages flight command dispatch with strict finite state machine (FSM) safety controls, aggregates real-time drone telemetry, and ingests edge AI waste detection events.

---

## 🏗️ System Architecture & Data Flow

```mermaid
flowchart TD
    subgraph Clients["Operators & Remote Pilots"]
        Browser["Pilot Dashboard (Web UI)"]
        Operator["Authorized Flight Operator"]
    end

    subgraph EdgeBoundary["Reverse Proxy & Gateway (Port 8080)"]
        Nginx["Nginx Reverse Proxy (nginx.conf)"]
        VideoGate["Operator Token Gate (/video_feed)"]
        RateGate["Ingestion & Client Limits"]
    end

    subgraph BackendCore["EcoWing Backend (Node.js / Express: Port 3000)"]
        Router["API & Ingestion Router"]
        AuthMdl["Auth Middleware (Operator & Drone Tokens)"]
        FSM["Safety Command Manager (UUIDv4 FSM & Freshness Guard)"]
        RateLmt["Sliding Window Rate Limiter"]
        Store["DetectionStore (In-Memory / Persistent JSON)"]
        SocketIO["Socket.IO Server (CORS Restricted)"]
    end

    subgraph DataTier["Data Persistence Tier (Internal Network)"]
        Mongo["MongoDB 7.0.14-jammy (--auth enabled)"]
        TelemetryColl["Telemetry (7-Day TTL Index)"]
        DetectionColl["Detections (Canonical Event ID Deduplication)"]
        DroneColl["Drone Fleet State"]
    end

    subgraph SensorNetwork["Detection Sensor Network (Edge Companion Computer)"]
        FastAPI["Detection FastAPI (Port 5000)"]
        Outbox["Persistent SQLite Outbox (outbox.db)"]
    end

    Browser -->|HTTP / WS| Nginx
    Operator -->|X-Operator-Token| Nginx
    Nginx -->|Reverse Proxy| Router
    Nginx -->|Gated Stream| VideoGate
    VideoGate -->|Proxy to 5000| FastAPI
    Outbox -->|X-Drone-Token Auth POST| Router
    Router --> AuthMdl
    AuthMdl --> RateLmt
    RateLmt --> FSM
    FSM --> SocketIO
    Router --> Store
    Store --> DetectionColl
    Router --> TelemetryColl
    Router --> DroneColl
```

---

## 🔒 Trust Boundaries & Network Topology

| Component | Network Binding | Port | Access Rule & Authentication | Trust Boundary |
| :--- | :--- | :---: | :--- | :--- |
| **Public Gateway** | Host Network / LAN | `8080` | Nginx reverse proxy. Serves static dashboard, proxies `/api`, `/socket.io`, and `/video_feed`. | Public Gateway / Pilot Edge |
| **Backend API** | Internal Docker bridge | `3000` | Unmapped to host. Loopback only in local dev (`127.0.0.1`). | Internal Command Service |
| **MongoDB** | Internal Docker bridge | `27017` | Unmapped to host. Requires `--auth` and user credentials in URI. | Internal Persistence Tier |
| **Detection Sensor** | Internal Docker bridge | `5000` | Edge sensor node. Loopback only in local dev. Gated via Nginx. | Edge Sensor Node |
| **Drone Telemetry Link** | HTTP Ingestion | `/api/drone/*` | Enforces `X-Drone-Token` + `X-Drone-Id` per-drone device auth. | Authenticated Device Link |
| **Operator Commands** | Operator REST | `/api/drone/command` | Enforces `X-Operator-Token` (min 32 chars, high entropy). | Trusted Flight Operator |

---

## 🏃 Run Paths & Execution Instructions (E12)

### 1. Docker Compose Run Path (Recommended Production Deployment)
In containerized deployment, all client traffic routes through **Nginx on port 8080**. Backend (3000) and MongoDB (27017) are unmapped from the host network.

```bash
# 1. Export required environment variables
export MONGO_INITDB_ROOT_USERNAME=ecowing_admin
export MONGO_INITDB_ROOT_PASSWORD="your_secure_database_password_123"
export MONGO_URI="mongodb://ecowing_admin:your_secure_database_password_123@mongodb:27017/ecowing?authSource=admin"
export ECOWING_OPERATOR_TOKEN="your_secure_operator_token_at_least_32_chars_long_123"
export DRONE_DEVICE_TOKENS='{"Drone-01":"your_secure_drone_token_at_least_32_chars_long_123"}'

# 2. Build and launch container stack
docker compose up -d --build
```
- **Pilot Dashboard:** `http://localhost:8080`
- **Nginx Reverse Proxy:** Routes `/api` to `backend:3000`, `/video_feed` to `detection:5000`.
- **Backend & Database:** Contained strictly within the `ecowing_net` bridge network.

### 2. Local Development Run Path
For local development without Docker:
1. Start MongoDB locally with authentication or run in memory mode.
2. In `EcoWing/backend`:
   ```bash
   cp .env.example .env
   # Edit backend/.env to configure ECOWING_OPERATOR_TOKEN and MONGO_URI
   npm install
   npm start
   ```
   Backend listens on `http://127.0.0.1:3000`.
3. In `detction system`:
   ```bash
   export DETECTION_OPERATOR_TOKEN="your_secure_operator_token_at_least_32_chars_long_123"
   python -m uvicorn app:app --host 127.0.0.1 --port 5000
   ```
4. Access dashboard via local Nginx or open `http://localhost:3000`.

---

## 🛡️ Security Architecture & Safety Controls

1. **Physical Drone Safety Controls & FSM State Machine (E9):**
   - Commands (`/api/drone/command`) require UUIDv4 `command_id` tracking.
   - Commands follow a strict state machine lifecycle: `requested` -> `sent` -> `acknowledged` -> `executing` -> `completed`.
   - Illegal state jumps (e.g. `requested` directly to `completed`) are rejected.
   - **Stale Telemetry Failsafe:** Flight commands are rejected with HTTP 409 Conflict if telemetry has not been updated within 10 seconds.
   - **ACK Timeout:** Commands transitioning to `sent` arm an ACK timer. If the drone companion computer fails to acknowledge within the window, the command transitions to `timed_out`.

2. **Operator Authentication (`ECOWING_OPERATOR_TOKEN`):**
   - Startup validation enforces a minimum length of 32 characters, 12 unique characters, and non-repeating entropy.
   - All flight control endpoints (`/api/drone/command`, `/api/camera/command`, `/api/drone/select`, `/api/drone/connect`, `/api/feed/clear`, `/api/export/*`) require `X-Operator-Token`.

3. **Per-Drone Device Token Authentication (E2, I5):**
   - Telemetry ingestion (`/api/drone/telemetry`), detection events (`/api/drone/detection`), and camera frames (`/api/drone/stream-frame`) require `X-Drone-Token` and `X-Drone-Id`.
   - Verified via constant-time cryptographic comparison (`crypto.timingSafeEqual`).
   - Cross-drone token reuse (Token A with Drone-B ID) is rejected with HTTP 401.

4. **Target Address Allowlist & Anti-SSRF (Anti-DNS Rebinding):**
   - Connecting companion cameras via `stream_url` validates targets against `DRONE_TARGET_ALLOWLIST` (default: empty deny-all).
   - Hostnames are resolved to IP literals; all returned addresses are checked against the allowlist. Connections target verified IPs directly with HTTP redirects strictly prohibited.

5. **Payload Limits & Ingestion Rate Limiting (E7):**
   - Maximum JSON/body payload is restricted to 5 MB (returns HTTP 413 Payload Too Large on overflow).
   - Ingestion endpoints (`/telemetry`, `/detection`, `/stream-frame`) are governed by sliding window rate limits returning HTTP 429 with `Retry-After`.

6. **Telemetry TTL Retention Index (E8):**
   - Mongoose telemetry schema defines a TTL index on `timestamp` with `expireAfterSeconds` defaulting to 7 days (604,800s), configurable via `TELEMETRY_TTL_SECONDS`.

7. **Detection Event Ingestion & Idempotence (I1):**
   - Canonical detection events require UUIDv4 `event_id`, source enum, taxonomy version, and normalized confidence in `[0.0, 1.0]`.
   - Duplicate pushes of the same `event_id` are recognized via `canonical_event_id` index and return `duplicate: true`, preventing duplicate records in storage.

8. **Shared NAT Pairing & Lockout Architecture (OP-SHARED-LOCKOUT):**
   - Drone device tokens and mobile sessions decouple authentication rate limits from remote IP addresses.
   - When multiple field units or companion computers share a single cellular NAT gateway, authentication tracking is keyed by authenticated device identifier (`X-Drone-Id`, `session_token`), preventing one malfunctioning unit from locking out other drones sharing the same NAT IP.

---

## 🧪 Automated Testing & Verification

EcoWing maintains automated test coverage across both Node.js and Python test runners:
```bash
# Run Node.js Test Suite (74 tests)
npm test --prefix backend

# Run Python Security & Contract Suite (31 tests)
pytest test_drone_security.py -v
```
Continuous integration executes automatically on push and pull requests via `.github/workflows/ci.yml`.
