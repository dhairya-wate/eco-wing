# System API & Schema Contract Changes

This document records all contract changes across the EcoWing and Detection architectures, tracking field names, old and new values, and migration notes in accordance with Ground Rule **R6**.

---

## 1. Phase 3: EcoWing Ingestion & Command Center Contracts

### 1.1 Detection Event Ingestion Contract (`POST /api/drone/detection`)
- **Category:** Sensor to Command Center Ingestion
- **Field / Payload:** Request body JSON
- **Old Contract:** Ad-hoc payload accepting arbitrary strings, percentage confidence (0–100), and unvalidated coordinates.
- **New Contract:** Validated strictly against canonical schema `contracts/detection-event.schema.json`:
  - `event_id`: Valid UUIDv4 string (`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`).
  - `observed_at`: ISO 8601 UTC date-time string.
  - `source`: Enum (`"camera"` | `"mobile"` | `"upload"`).
  - `taxonomy_version`: SemVer string (e.g. `"1.0.0"`).
  - `classification_method`: Enum (`"coco_mapping"`).
  - `items`: Array of detection items, each requiring:
    - `class_id`: Canonical class identifier from `contracts/taxonomy.yaml` (e.g. `bottle`, `cup`, `banana`).
    - `confidence`: Finite float in the unit range `[0.0, 1.0]`.
    - `bbox`: Array of 4 numbers `[ymin, xmin, ymax, xmax]`.
- **Response:** HTTP 200 on success; HTTP 400 Bad Request with descriptive error details on schema violation.
- **Migration Notes:** Detection service transmits events via the SQLite outbox client (`outbox.py`), which constructs payloads strictly matching `detection-event.schema.json`.

### 1.2 Drone Command Execution & Lifecycle Contract (`POST /api/drone/command`)
- **Category:** Operator Drone Command & Physical Safety (E9)
- **Field / Payload:** Request & response contract
- **Old Contract:** Fire-and-forget JSON (`{ "status": "ok", "message": "Command broadcast" }`) without unique tracking ID or status lifecycle.
- **New Contract:** Strictly typed safety state machine matching `contracts/command.schema.json`:
  - Request: Requires `X-Operator-Token` header. Body requires `drone_id` and allowlisted `command` verb (`"start"` | `"hold"` | `"rth"` | `"land"`).
  - Telemetry Freshness Guard: If drone telemetry is older than 10.0 seconds or nonexistent, flight commands are rejected with HTTP 409 Conflict (`{ "error": "Stale telemetry: Drone has not reported telemetry in X.X seconds. Command aborted for flight safety." }`).
  - Response:
    ```json
    {
      "status": "success",
      "command": {
        "command_id": "c1f7a240-...",
        "drone_id": "Drone-01",
        "command": "land",
        "state": "sent",
        "state_history": [
          { "state": "requested", "timestamp": "...", "reason": "operator initiated" },
          { "state": "sent", "timestamp": "...", "reason": "dispatched to drone link" }
        ],
        "created_at": "...",
        "updated_at": "..."
      }
    }
    ```
  - ACK Timeout: Commands not transitioned to `"acknowledged"` within configurable timeout (default 5.0 seconds) automatically transition to terminal state `"timed_out"`.
  - Additive Query & Transition Endpoints:
    - `GET /api/drone/command/:id`: Fetches command state and history.
    - `POST /api/drone/command/:id/state`: Drone autopilot status callback (`state`: `"acknowledged"` | `"executing"` | `"completed"` | `"failed"` | `"rejected"`).
- **Migration Notes:** Operators and autonomous scripts must track `command_id` and monitor status updates via SSE/WebSocket or `GET /api/drone/command/:id`.

### 1.3 Payload Limit & Ingestion Rate Limiting Contract (E7)
- **Category:** Network & Memory Denial of Service Protection
- **Field / Payload:** Request body and HTTP headers
- **Old Contract:** 20MB body size allowed on all endpoints; unbounded ingestion rate.
- **New Contract:**
  - Body Size: 5MB maximum limit across all JSON, URL-encoded, and raw stream bodies. Requests exceeding 5MB are rejected with HTTP 413 Payload Too Large (`{ "status": "error", "error": "Payload Too Large", "message": "Request body exceeds the maximum permitted limit of 5MB." }`).
  - Sliding Window Rate Limiting: Ingestion routes (`/api/drone/telemetry`, `/api/drone/detection`, `/api/drone/stream-frame`) enforce an in-memory sliding window rate limiter keyed per authenticated drone ID.
  - Headers Emitted: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and on HTTP 429: `Retry-After: <seconds>`.
- **Migration Notes:** Stream frame broadcasters should compress frames to stay well below 5MB (typical JPEG frames are 50–300 KB) and calibrate telemetry send rate to 1–2 Hz.

### 1.4 Telemetry Data Retention TTL Contract (E8)
- **Category:** Database Retention Policy
- **Collection:** MongoDB `telemetries` collection
- **Old Contract:** Telemetry documents stored permanently without automatic cleanup.
- **New Contract:** Mongoose schema TTL expiration index on `timestamp` with `expireAfterSeconds: TELEMETRY_TTL_SECONDS` (default: 604800 seconds = 7 days).
- **Migration Notes:** Historical operational data older than 7 days will automatically expire from MongoDB. Archive long-term data externally using CSV/JSON exports (`/export/csv`, `/export/json`) if permanent retention is required.

---

## 2. Phase 5: Detection Ingestion Idempotency & Deduplication (I1)

### 2.1 Detection Deduplication & Idempotent Response (`POST /api/drone/detection`)
- **Category:** Ingestion Reliability & Exactly-Once Semantics (I1)
- **Field / Payload:** Response JSON
- **Old Contract:** Submitting the same detection event twice created duplicate records in storage.
- **New Contract:**
  - Ingestion checks incoming canonical `event_id` (UUIDv4) against indexed `canonical_event_id` in storage.
  - If already ingested, returns HTTP 200 with `duplicate: true`:
    ```json
    {
      "success": true,
      "count": 1,
      "duplicate": true,
      "events": [...]
    }
    ```
  - No duplicate documents are inserted into `detectionStore` or MongoDB `Detection`.
- **Migration Notes:** Client outbox senders can safely retry events upon network timeouts without risking duplicate event recording.

---

## 3. Detection Sensor API Contracts

### 3.1 Public Detections Feed (`GET /api/detections`)
- **Category:** Public Telemetry Feed
- **Old Contract:**
  - `data.items[i].confidence`: Float in range `0.0 - 100.0` (percentage).
  - `data.items[i].recyclable`: Boolean (`true` / `false`).
  - `data.items[i].biodegradable`: Boolean (`true` / `false`).
  - `timestamp`: Ad-hoc string.
- **New Contract:**
  - `data.items[i].confidence`: Float strictly normalized to `[0.0, 1.0]`.
  - `data.items[i].recyclable`: Categorical string enum (`"yes"` | `"no"` | `"estimated"` | `"depends"` | `"unknown"`).
  - `data.items[i].biodegradable`: Categorical string enum (`"yes"` | `"no"` | `"estimated"` | `"depends"` | `"unknown"`).
  - `timestamp`: Preserved Unix float epoch seconds (e.g. `1793215978.123`).
  - `timestamp_iso`: Additive ISO 8601 UTC date-time string.
  - `age_seconds`: Elapsed float seconds since last model inference update.
  - `stale`: Boolean (`true` if `age_seconds > DETECTION_STALE_AFTER_SECONDS` [default 5.0s]).
  - `scope`: Constant `"live_frame"`.
- **Migration Notes:** Frontends must multiply confidence by 100 only when rendering UI percentage text.

### 3.2 Detector Settings Endpoint (`POST /api/settings`)
- **Category:** Sensor Configuration
- **Old Contract:** Accepted integer percentage `50` for confidence threshold.
- **New Contract:** Strictly accepts unit float in `[0.0, 1.0]` (e.g. `0.5`). Values `> 1.0` or `< 0.0` or non-finite (`NaN`, `inf`) are rejected with HTTP 400.
- **Migration Notes:** Configuration scripts must transmit confidence as decimals (`0.50` instead of `50`).

### 3.3 System Info Endpoint (`GET /api/system_info`)
- **Category:** Diagnostic & Reverse-Proxy Relative Paths (D8)
- **Old Contract:** Unauthenticated endpoint returning hardcoded LAN IP absolute URLs.
- **New Contract:**
  - Requires `X-Operator-Token` header.
  - Respects `X-Forwarded-Proto` and `X-Forwarded-Host`.
  - Additive fields: `relative_stream_path: "/video_feed"`, `relative_api_path: "/api/detections"`, `worker_running: true/false`.
- **Migration Notes:** Web applications embedding live video must use relative paths to eliminate browser HTTPS mixed content blocking.
