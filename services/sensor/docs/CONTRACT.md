# System API & Schema Contract Changes

This document records all contract changes across the EcoWing and Detection architectures, tracking field names, old and new values, and migration notes in accordance with Ground Rule **R6**.

---

## 1. Phase 3: EcoWing Ingestion & Command Center Contracts

### 1.1 Detection Event Ingestion Contract (`POST /api/drone/detection`)
- **Category:** Sensor to Command Center Ingestion
- **Field / Payload:** Request body JSON
- **Old Contract:** Ad-hoc payload accepting arbitrary strings, percentage confidence (0–100), and unvalidated coordinates.
- **New Contract:** Validated strictly against canonical schema `contracts/detection-event.schema.json`:
  - `event_id`: Valid UUIDv4 string (`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`).
  - `timestamp`: ISO 8601 UTC date-time string.
  - `source`: Enum (`"camera"` | `"mobile"` | `"companion"`).
  - `detections`: Array of detection items, each requiring:
    - `class_id`: Canonical class identifier from `contracts/taxonomy.yaml` (e.g. `plastic_bottle`, `metal_can`, `glass_bottle`).
    - `confidence`: Finite float in the unit range `[0.0, 1.0]`.
    - `bbox`: Array of 4 floats `[ymin, xmin, ymax, xmax]` normalized to `[0.0, 1.0]`.
  - `frame_id`: Non-negative integer.
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
