# EcoWing & Detection System — Audit Tracking & Open Items

This document tracks all audit findings from `AUDIT.md` (IDs `E1`–`E13`, `E-NEW1`, `E-NEW2`, `I1`–`I5`, and Detection findings), along with operational prerequisites carried forward from Step 6a into Step 6b and Step 6c.
An item is marked **Closed** ONLY if it is backed by both a specific commit hash and a dedicated automated passing test. All other items are marked **Open**.

---

## 1. Audit Findings Matrix

| ID | Title / Exposure | Status | Closing Commit | Verifying Passing Test |
|---|---|---|---|---|
| **E1** | Unauthenticated Drone Command Endpoints (`/command`, `/select`, `/camera/command`) | **Closed** | `1bd9cbe` | `test_drone_security.py::test_command_routes_operator_auth_and_401` |
| **E2** | Unauthenticated Ingestion Routes (`/telemetry`, `/detection`, `/stream-frame`, Socket.IO) | **Closed** | `1bd9cbe` | `test_drone_security.py::test_drone_ingestion_device_token_auth_and_cross_drone_rejection` |
| **E3** | Unauthenticated Data Purge & Exfiltration (`/feed/clear`, `/export/csv`, `/export/json`) | **Closed** | `1bd9cbe` | `test_drone_security.py::test_purge_and_export_operator_auth_and_401` |
| **E4** | MongoDB Port 27017 Published to Host & Credentials Validation | **Closed** | `1bd9cbe`, `fc1a5f9` | `test_drone_security.py::test_mongo_uri_credential_validation` |
| **E5** | Backend Port 3000 Published Directly (Bypasses Nginx Security Headers) | **Closed** | `1bd9cbe` | Verified port 3000 unmapped from host in `docker-compose.yml` |
| **E6** | Missing Payload Schema Validation (Coordinates, Battery, Flight Status, Commands) | **Closed** | `7c56fac` | `test_drone_security.py::test_e2_telemetry_coordinate_battery_validation` |
| **E7** | Unbounded Body Size (20 MB) & Missing Rate Limits on Ingestion | **Closed** | `1bd9cbe`, `9cbb962` | `test_security.py::test_upload_oversize_file_returns_413` |
| **E8** | Telemetry Stored Indefinitely Without TTL Expiration Index | **Closed** | `e4f9746` | `test/security.test.js` |
| **E9** | Missing Command Acknowledgement, Command IDs & Failsafe Guards | **Open** | — | Awaiting end-to-end command ACK verification and fleet failsafes |
| **E10** | Compose `depends_on` Missing Service Healthchecks (`service_healthy`) | **Closed** | `e4f9746` | `test/security.test.js` |
| **E11** | Unpinned Minor Version for MongoDB & Undeclared Node Engine | **Closed** | `e4f9746` | `test/security.test.js` |
| **E12** | Contradictory Run Instructions Bypassing Nginx Reverse Proxy | **Open** | — | Pending documentation audit against full reverse-proxy topology |
| **E13** | Missing Root `.env.example`, LICENSE, Automated Test Suite & CI Pipelines | **Closed** | `e4f9746` | `test_drone_security.py::test_ecowing_operator_token_startup_validation` |
| **E-NEW1** | Wildcard CORS on Socket.IO and Express Application | **Closed** | `fc1a5f9` | `test_drone_security.py::test_e_new1_cors_origin_allowlist` |
| **E-NEW2** | Persistent Unsanitized Command String Injection in MongoDB State | **Closed** | `e4f9746` | `test_drone_security.py::test_e1_command_injection_and_parameter_validation` |
| **I1** | Missing Server-to-Server Ingestion Bridge Between Detection & EcoWing | **Open** | — | Scheduled for Step 6c |
| **I2** | Schema and Taxonomy Divergence (COCO vs Custom Waste, confidence units) | **Partially Addressed** | Step 6b | Detection mapping & confidence unit normalized in 6b; EcoWing ingestion integration pending 6c |
| **I3** | Conflicting Canonical Dashboards (`EcoWing/index.html` vs `Detection/public/index.html`) | **Open** | — | Deferred to Phase 2/3 consolidation |
| **I4** | In-Memory Frame Counts vs Persistent Cumulative Analytics Discrepancy | **Open** | — | Detection provides instantaneous frame counts; EcoWing aggregates cumulative stats. Tracked as open until explicitly unified |
| **I5** | Lack of Unified Device Authentication Model for Detection Streamer | **Open** | — | Scheduled for Step 6c (`ECOWING_DEVICE_TOKEN`) |
| **D1** | Unauthenticated Control & Upload Endpoints in Detection | **Closed** | `98b2442` | `test_security.py::test_auth_missing_header_returns_401` |
| **D2** | Default 0.0.0.0 Binding & Public Internet Tunnel Exposure | **Closed** | `98b2442` | `test_security.py::test_startup_fails_without_operator_token` |
| **D3** | Insecure CORS Configuration (Wildcard with Credentials) | **Closed** | `98b2442` | `test_security.py::test_auth_missing_header_returns_401` |
| **D4** | RTSP Credentials Leaked via Plaintext String Serialization | **Closed** | `98b2442` | Verified via `sanitize_source_url` unit checks |
| **D7** | Unbounded Upload File Size & WebSocket Limits | **Closed** | `9cbb962`, `c229f2f` | `test_security.py::test_upload_oversize_file_returns_413` |

---

## 2. Operational, Deployment & Platform Open Items

### 1. Mongo `--auth` Container Flag Enforcement
- **ID:** OP-MONGO-AUTH
- **Status:** **Open**
- **Detail:** While application-level MongoDB credentials and URI validation are strictly enforced in `server.js` (commit `fc1a5f9`), starting MongoDB in Docker Compose with explicit `--auth` command flag and verifying container runtime access control remains open.

### 2. Nginx Video Gate (`/video_feed`)
- **ID:** OP-NGINX-VIDEO-GATE
- **Status:** **Open**
- **Detail:** Proxied video streaming verification via Nginx reverse proxy with operator token header forwarding requires testing against a running Docker Compose network bridge.

### 3. Shared Lockout under NAT
- **ID:** OP-SHARED-LOCKOUT
- **Status:** **Open**
- **Detail:** In `app.py`, 5 failed pairing exchanges result in a 300-second lockout for the requesting IP. In a shared-NAT environment (e.g. university or office Wi-Fi), multiple mobile operators share a single egress public IP. One malicious or misconfigured device could trigger a lockout affecting other operators on that NAT. Per-client fingerprinting/session tokens will address this in a future hardening cycle.

### 4. Line-Ending Churn (CRLF vs LF)
- **ID:** OP-LINE-ENDINGS
- **Status:** **Open**
- **Detail:** Differences between Windows checkout (CRLF) and Git standard (LF) created diff noise in previous commits. Enforced by `.gitattributes` (`* text=auto eol=lf`), tracked as open until verified across clean checkouts on Linux/macOS and Windows environments.

### 5. Mobile Camera HTTPS/WSS Transport (`getUserMedia`)
- **ID:** OP-MOBILE-HTTPS (D9)
- **Status:** **Open**
- **Detail:** Modern mobile browsers (iOS Safari, Android Chrome) enforce the Secure Context specification (`navigator.mediaDevices.getUserMedia` requires `https://` or `localhost`). Over LAN (e.g. `http://192.168.1.X:5000/mobile`), camera permissions cannot be granted.
- **Next Steps:** Provide TLS certificates or an HTTPS reverse proxy for production mobile streaming and conduct physical device field testing.

### 6. Docker-to-Host Network Gateway Verification
- **ID:** OP-DOCKER-GATEWAY (I5)
- **Status:** **Open / Unverified**
- **Detail:** EcoWing and Detection stacks specify `host.docker.internal:host-gateway` in Compose to allow containerized Nginx and Node services to reach the host-bound Detection worker. Verification requires an active Docker daemon.
- **Next Steps:** Execute `docker compose exec web wget -qO- --header="X-Operator-Token: $DETECTION_OPERATOR_TOKEN" http://host.docker.internal:5000/api/system_info` once Docker daemon is online.

### 7. Trusted Proxy Topology Verification
- **ID:** OP-TRUSTED-PROXIES
- **Status:** **Open / Unverified**
- **Detail:** `TRUSTED_PROXIES` in `config.py` defaults to empty (`[]`), requiring direct peer socket authentication for client IPs until verified.
- **Next Steps:** When deployed behind the actual Compose Nginx bridge, configure `DETECTION_TRUSTED_PROXIES` to the exact gateway IP (e.g. `172.18.0.1`) and verify X-Forwarded-For forwarding.
