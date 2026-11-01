# EcoWing & Detection System — Master Audit Tracking & Open Items

This document is the authoritative tracking registry for all security, correctness, architecture, and operational findings across the EcoWing and Detection repositories.
In accordance with Ground Rule **R2**, an audit item is marked **Closed** ONLY if it is backed by a specific commit hash (verified with `git cat-file -t <hash>`) AND a dedicated passing automated test that explicitly asserts that control. All other items are marked **Open**, **Partial**, or **Unverified**.

---

## 1. Authoritative Audit Items from AUDIT.md (37 Items Total)

### 1.1 EcoWing Command Center Findings (15 Items)

| ID | Category | Title / Exposure | Status Under R2 | Commit | Dedicated Passing Test | R2 Evaluation / Blocker |
|---|---|---|---|---|---|---|
| **E1** | Safety/Security | Unauthenticated Drone Command Endpoints (`/command`, `/select`, `/camera/command`) | **Closed** | `1c1294c`, `1bd9cbe` | `test_drone_security.py::test_command_routes_operator_auth_and_401` | Asserts 401 on missing token, 401 on bad token, 200 on valid token for `/api/drone/command`, `/api/camera/command`, `/api/drone/select`. |
| **E2** | Safety/Security | Unauthenticated Ingestion Routes (`/telemetry`, `/detection`, `/stream-frame`, Socket.IO) | **Closed** | `1bd9cbe`, `7c56fac` | `test_drone_security.py::test_drone_ingestion_device_token_auth_and_cross_drone_rejection`, `test_drone_security.py::test_e2_telemetry_coordinate_battery_validation`, `backend/test/security.test.js` | Asserts 401 on missing/bad/cross-drone token; bounds validation on coordinates and battery. |
| **E3** | Security | Unauthenticated Data Purge & Exfiltration (`/feed/clear`, `/export/csv`, `/export/json`) | **Closed** | `1bd9cbe` | `test_drone_security.py::test_purge_and_export_operator_auth_and_401` | Asserts 401 on missing/bad operator token, 200 with valid token for all 3 purge/export endpoints. |
| **E4** | Security | MongoDB Port 27017 Published to Host with Insecure Default Credentials | **Partial / Unverified** | `fc1a5f9` (app URI check) | `test_drone_security.py::test_mongo_uri_credential_validation`, `backend/test/security.test.js` | URI credential check closed in app code. Host port removal and Mongo `--auth` container flag require Docker runtime test (R3). |
| **E5** | Security | Backend Port 3000 Published Directly (Bypasses Nginx Security Headers) | **Open / Unverified** | `1bd9cbe` (compose edit) | None (compose edit only) | Host port mapping removed from `docker-compose.yml`, but lacks automated test. Requires Docker runtime verification under R2/R3. |
| **E6** | Correctness/Safety | Missing Payload Schema Validation (Coordinates, Battery, Flight Status, Commands) | **Partial** | `7c56fac` (telemetry bounds) | `test_drone_security.py::test_e2_telemetry_coordinate_battery_validation` | Telemetry coordinates and battery bounds closed; detection event schema validation scheduled for Phase 1 / Phase 3.1. |
| **E7** | Reliability | Unbounded Body Size (20 MB) & Missing Rate Limits on Ingestion | **Open** | — | — | Scheduled for Phase 3.5 (`express-rate-limit`). |
| **E8** | Reliability | Telemetry Stored Indefinitely Without TTL Expiration Index | **Open** | — | — | Scheduled for Phase 3.3 (configurable TTL index, default 7 days). |
| **E9** | Safety | Missing Command Acknowledgement, Command IDs & Failsafe Guards | **Open** | — | — | Scheduled for Phase 3.2. Critical physical safety item: command IDs, state machine transitions, stale telemetry rejection, ACK timeouts. |
| **E10** | Infrastructure | Compose `depends_on` Missing Service Healthchecks (`condition: service_healthy`) | **Open / Unverified** | — | — | Scheduled for Phase 3.8. Requires Docker compose runtime verification. |
| **E11** | Maintenance | Unpinned Minor Version for MongoDB (`mongo:7-jammy`) & Undeclared Node Engine | **Open** | — | — | Scheduled for Phase 3.8 (pin Mongo image tag, define engine in `package.json`). |
| **E12** | Documentation | Contradictory Run Instructions Bypassing Nginx Reverse Proxy | **Open** | — | — | Scheduled for Phase 6.1 (README architecture and run paths). |
| **E13** | Governance | Missing Root `.env.example`, LICENSE, Automated Test Suite & CI Pipelines | **Partial** | `0b820ab`, `f910515` | `test_drone_security.py`, `backend/test/security.test.js` (57 tests) | Test suite established; root `.env.example`, LICENSE, and CI pipelines remain open. |
| **E-NEW1** | Security | Wildcard CORS on Socket.IO and Express Application | **Partial** | `fc1a5f9` | `test_drone_security.py::test_e_new1_cors_origin_allowlist`, `backend/test/security.test.js` | Downgraded from Closed: current tests only check `allowedOrigins` array. Dedicated HTTP request test asserting rejection of unauthorized Origin headers pending Phase 3.6. |
| **E-NEW2** | Security | Persistent Unsanitized Command String Injection in MongoDB State | **Closed** | `1c1294c` | `test_drone_security.py::test_e1_command_injection_and_parameter_validation` | Asserts command strings outside allowlist (e.g. `'reboot_os; rm -rf /'`) rejected with 400. |

### 1.2 Integration Findings (5 Items)

| ID | Category | Title / Exposure | Status Under R2 | Commit | Dedicated Passing Test | R2 Evaluation / Blocker |
|---|---|---|---|---|---|---|
| **I1** | Integration | Missing Server-to-Server Ingestion Bridge Between Detection & EcoWing | **Open** | — | — | Scheduled for Phase 2.3 (SQLite outbox sender) and Phase 5.1 (end-to-end integration). |
| **I2** | Integration | Schema and Taxonomy Name Divergence (Snake Case vs Title Case vs COCO) | **Partial / In Progress** | `64e8b48` (Detection side) | `test_correctness.py::test_every_mapping_coco_label_exists_in_model_classes` | Detection mapping implemented; shared `contracts/` single source of truth pending Phase 1. |
| **I3** | Architecture | Conflicting Canonical Dashboards (`EcoWing/index.html` vs `Detection/public/index.html`) | **Open** | — | — | Scheduled for Phase 2.9 (strip duplicate controls from Detection) & Phase 3.7. |
| **I4** | Architecture | In-Memory Frame Counts vs Persistent Cumulative Analytics Discrepancy | **Open** | — | — | Scheduled for Phase 2.2 (label `/api/detections` as live-window values, document non-cumulative nature). |
| **I5** | Security | Lack of Unified Device Authentication Model for Detection Streamer | **Partial** | `1bd9cbe` (EcoWing ingestion) | `test_drone_security.py::test_drone_ingestion_device_token_auth_and_cross_drone_rejection` | EcoWing token ingestion ready; Detection outbox client token sender pending Phase 2.3. |

### 1.3 Detection System Findings (17 Items)

| ID | Category | Title / Exposure | Status Under R2 | Commit | Dedicated Passing Test | R2 Evaluation / Blocker |
|---|---|---|---|---|---|---|
| **D1** | Security | Unauthenticated Control & Upload Endpoints (`/api/settings`, `/api/upload`, `/api/system_info`) | **Closed** | `98b2442`, `9cbb962` | `test_security.py::test_auth_missing_header_returns_401`, `test_security.py::test_auth_query_param_token_rejected_returns_401`, `test_security.py::test_auth_valid_header_returns_200` | Asserts 401 without header, 401 with query parameter token, 200 with valid header. |
| **D2** | Security | Default 0.0.0.0 Binding & Public Internet Tunnel Exposure | **Open / Unverified** | `98b2442` (config edit) | None | Default changed to 127.0.0.1 in config, but lacks dedicated automated test asserting host bind and localtunnel script removal. Scheduled for Phase 2.6. |
| **D3** | Security | Insecure CORS Configuration (`allow_origins=["*"]` with `allow_credentials=True`) | **Open** | `98b2442` (config edit) | None | Fixed in code, but previously misattributed to auth test; dedicated CORS test pending Phase 2.6. |
| **D4** | Security | RTSP Credentials Leaked via Plaintext String Serialization | **Open** | `98b2442` (sanitizer function) | None | Sanitizer implemented in `app.py`, but lacks dedicated automated test under R2. Scheduled for Phase 2.8. |
| **D5** | Correctness | Detection Loop Tied to Video Viewers (Stale Telemetry Without Viewers) | **Closed** | `f07f467` | `test_correctness.py::test_worker_updates_results_with_zero_viewers`, `test_correctness.py::test_mobile_stream_frame_produces_detection_with_zero_viewers` | Asserts worker runs inference and updates `/api/detections` with 0 active MJPEG viewers. |
| **D6** | Performance | Redundant Per-Viewer YOLO Inference Loop | **Closed** | `f07f467` | `test_correctness.py::test_detector_calls_do_not_scale_with_viewers` | Asserts detector calls do not scale 3x when 3 viewers connect to `/video_feed`. |
| **D7** | Reliability | Missing Upload File Size Limits & Unbounded WebSocket Clients | **Closed** | `9cbb962`, `c229f2f` | `test_security.py::test_upload_oversize_file_returns_413`, `test_security.py::test_unauthenticated_sockets_count_against_connection_cap`, `test_security.py::test_concurrent_handshakes_gather_capped`, `test_security.py::test_ws_max_message_size_transport_rejection_code_1009` | Asserts 413 on upload > 5MB, 1013 on excess sockets (sync cap), 1009 on transport frame > 5MB. |
| **D8** | Integration | Mixed Content Blocking on HTTPS Embedding | **Open** | — | — | Scheduled for Phase 4 (Nginx reverse proxy topology). |
| **D9** | Integration | Browser Camera Access (`getUserMedia`) Blocked Over Plain HTTP | **Open** | — | — | Tracked as OP-1 / Phase 2.7. Mobile streaming requires secure context (HTTPS/localhost). |
| **D10** | Configuration | Hardcoded LAN IP (`192.168.31.44`) Across Documentation | **Open** | — | — | Scheduled for Phase 6.1 (README correction). |
| **D11** | Documentation | Incompatible Deployment Claims (FastAPI/PyTorch on Vercel) | **Open** | — | — | Scheduled for Phase 6.1 (clarify host run requirements). |
| **D12** | Correctness | Model Provenance & False Detection Capabilities (COCO vs Custom Waste) | **Closed (Detection side)** | `64e8b48` | `test_correctness.py::test_every_mapping_coco_label_exists_in_model_classes`, `test_correctness.py::test_recyclable_and_biodegradable_allowed_enum_values`, `test_correctness.py::test_unmapped_coco_labels_produce_no_waste_items` | Asserts mapping table matches model classes, allowed enums, and unmapped labels produce no waste items. Shared taxonomy pending Phase 1. |
| **D13** | Correctness | Inconsistent Confidence Units (0–1 vs 0–100 Percentage) | **Partial** | `cad3d01` | `test_correctness.py::test_all_confidence_values_within_zero_to_one`, `test_correctness.py::test_settings_confidence_contract_accepts_unit_float_and_rejects_percentage` | Downgraded to Partial per R2: confidence normalized to unit float, but `NaN` and `inf` validation (`math.isfinite`) on `POST /api/settings` remains pending Phase 2.5. |
| **D14** | Maintenance | Binary Model Committed Without Git LFS | **Open** | — | — | Documented provenance and SHA256; Git LFS migration deferred. |
| **D15** | Maintenance | Superfluous Node.js `package.json` in Python FastAPI Project | **Open** | — | — | Cleanup scheduled for Phase 6. |
| **D16** | Quality | Workspace and Directory Naming Inconsistencies | **Open** | — | — | Documented; localized workspace paths maintained. |
| **D-NEW1** | Integration | Hardcoded Third-Party Vercel Production Target (`eco-wing-7pua.vercel.app`) | **Open** | — | — | Scheduled for Phase 2.9 (remove external fallback target). |

---

## 2. Operational & Deployment Items (Added, Non-Audit: 6 Items)

| ID | Origin / Classification | Description | Status Under R2 | Verification Path | Justification & Requirements |
|---|---|---|---|---|---|
| **OP-1** | Added, non-audit | Mobile Camera HTTPS/WSS Transport (`getUserMedia`) | **Open** | Phase 2.7 | Required by modern browser W3C Secure Context specs for `getUserMedia`. Relates to finding D9; disabled by default unless TLS configured. |
| **OP-2** | Added, non-audit | Docker Network Gateway & Nginx Video Feed Gate (`/video_feed`) | **Open / Unverified** | Phase 4.2 | Mandated by deployment topology (user prompt Step 6a / Phase 4). Requires Docker daemon; Nginx `auth_request` validating operator token. |
| **OP-3** | Added, non-audit | Trusted Proxy Topology Verification | **Open / Unverified** | Phase 2.6 / 4.3 | Mandated by user prompt Step 6a / Phase 2.6. `TRUSTED_PROXIES` empty by default; requires exact gateway IP verification under Compose. |
| **OP-MONGO-AUTH** | Added, non-audit | Mongo `--auth` Container Flag Enforcement | **Open / Unverified** | Phase 3.4 | Mandated by user prompt Step 6a / Phase 3.4. Requires Docker daemon to verify container startup with explicit `--auth` flag. |
| **OP-SHARED-LOCKOUT** | Added, non-audit | Shared Lockout Under NAT | **Open** | Phase 6.1 | Mandated by user prompt Step 6a / Phase 6.1. Documents IP-based pairing lockout behavior for multiple devices behind shared NAT. |
| **OP-LINE-ENDINGS** | Added, non-audit | Line-Ending Normalization (CRLF vs LF) | **Open / In Progress** | Phase 0 / HEAD | Mandated by Ground Rule R7. Enforced by `.gitattributes` (`* text=auto eol=lf`) to eliminate line-ending churn across platforms. |

---

## 3. Summary of Status Counts

- **Authoritative Items from AUDIT.md:** 37
  - **Closed:** 9 (E1, E2, E3, E-NEW2, D1, D5, D6, D7, D12)
  - **Partial:** 5 (E4, E6, E13, E-NEW1, D13)
  - **Open / Unverified:** 23 (E5, E7, E8, E9, E10, E11, E12, I1, I2, I3, I4, I5, D2, D3, D4, D8, D9, D10, D11, D14, D15, D16, D-NEW1)
- **Added, Non-Audit Operational Items:** 6
  - **Open / Unverified:** 6 (OP-1, OP-2, OP-3, OP-MONGO-AUTH, OP-SHARED-LOCKOUT, OP-LINE-ENDINGS)
- **Grand Total Rows:** 43
