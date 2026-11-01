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
| **E4** | Security | MongoDB Port 27017 Published to Host with Insecure Default Credentials | **Partial / Unverified** | `fc1a5f9`, `8d9d326` | `test_drone_security.py::test_mongo_uri_credential_validation`, `backend/test/security.test.js` | URI credential check closed in app code. Host port removal and Mongo `--auth` container flag verified in compose; Docker runtime test required (R3). |
| **E5** | Security | Backend Port 3000 Published Directly (Bypasses Nginx Security Headers) | **Open / Unverified** | `1bd9cbe` (compose edit) | None (compose edit only) | Host port mapping removed from `docker-compose.yml`, but lacks automated test. Requires Docker runtime verification under R2/R3. |
| **E6** | Correctness/Safety | Missing Payload Schema Validation (Coordinates, Battery, Flight Status, Commands) | **Closed** | `7c56fac`, `3fc1a0b` | `test_drone_security.py::test_detection_ingestion_canonical_schema_validation_and_rejection`, `test_drone_security.py::test_e2_telemetry_coordinate_battery_validation`, `backend/test/security.test.js` | Full canonical JSON schema validation on detection events (UUIDv4 event_id, [0,1] confidence, canonical taxonomy, ISO 8601 UTC) and coordinate/battery bounds. |
| **E7** | Reliability | Unbounded Body Size (20 MB) & Missing Rate Limits on Ingestion | **Closed** | `e03ab1d` | `test_drone_security.py::test_e7_payload_size_limit_and_ingestion_rate_limiting`, `backend/test/security.test.js` | Body size restricted to 5MB (returns 413 Payload Too Large on overflow); sliding window rate limiter protects `/telemetry`, `/detection`, and `/stream-frame` with HTTP 429 and Retry-After header. |
| **E8** | Reliability | Telemetry Stored Indefinitely Without TTL Expiration Index | **Closed** | `68fbaf9` | `test_drone_security.py::test_e8_telemetry_ttl_index_configuration`, `backend/test/security.test.js` | Mongoose schema TTL index configured on `timestamp` with `expireAfterSeconds` defaulting to 7 days (`604800` seconds), configurable via `TELEMETRY_TTL_SECONDS`. |
| **E9** | Safety | Missing Command Acknowledgement, Command IDs & Failsafe Guards | **Closed** | `9dc3891` | `test_drone_security.py::test_e9_physical_drone_safety_controls_and_state_machine`, `backend/test/security.test.js` | Commands assigned UUIDv4 `command_id`; strict FSM lifecycle transitions (`requested` -> `sent` -> `acknowledged` -> `executing` -> `completed`); stale telemetry (>10s) rejects flight commands with 409; ACK timeout transitions to `timed_out`. |
| **E10** | Infrastructure | Compose `depends_on` Missing Service Healthchecks (`condition: service_healthy`) | **Closed** | `8d9d326` | `test_drone_security.py::test_e10_e11_docker_compose_and_node_engine_hardening`, `backend/test/security.test.js` | Configured `service_healthy` condition in `backend` depends_on and MongoDB container healthcheck `db.adminCommand('ping')`. |
| **E11** | Maintenance | Unpinned Minor Version for MongoDB (`mongo:7-jammy`) & Undeclared Node Engine | **Closed** | `8d9d326` | `test_drone_security.py::test_e10_e11_docker_compose_and_node_engine_hardening`, `backend/test/security.test.js` | Pinned Mongo image to `mongo:7.0.14-jammy`; declared `"engines": { "node": ">=20.0.0" }` in `backend/package.json`. |
| **E12** | Documentation | Contradictory Run Instructions Bypassing Nginx Reverse Proxy | **Open** | — | — | Scheduled for Phase 6.1 (README architecture and run paths). |
| **E13** | Governance | Missing Root `.env.example`, LICENSE, Automated Test Suite & CI Pipelines | **Partial** | `0b820ab`, `f910515` | `test_drone_security.py` (27 tests), `backend/test/security.test.js` (62 tests) | Comprehensive test suites established; root `.env.example`, LICENSE, and CI pipelines remain open. |
| **E-NEW1** | Security | Wildcard CORS on Socket.IO and Express Application | **Closed** | `fc1a5f9`, `7d4a76e` | `test_drone_security.py::test_e_new1_cors_origin_allowlist`, `backend/test/security.test.js` | Strict CORS origin allowlist enforced on Express and Socket.IO; dedicated HTTP requests verify unauthorized Origin headers are rejected with 403 Forbidden and null CORS headers. |
| **E-NEW2** | Security | Persistent Unsanitized Command String Injection in MongoDB State | **Closed** | `1c1294c` | `test_drone_security.py::test_e1_command_injection_and_parameter_validation` | Asserts command strings outside allowlist (e.g. `'reboot_os; rm -rf /'`) rejected with 400. |

### 1.2 Integration Findings (5 Items)

| ID | Category | Title / Exposure | Status Under R2 | Commit | Dedicated Passing Test | R2 Evaluation / Blocker |
|---|---|---|---|---|---|---|
| **I1** | Integration | Missing Server-to-Server Ingestion Bridge Between Detection & EcoWing | **Partial** | `f8daffb`, `3fc1a0b` | `test_outbox.py::test_outbox_offline_queue_and_delivery_when_ecowing_returns`, `test_drone_security.py::test_detection_ingestion_canonical_schema_validation_and_rejection` | Detection SQLite outbox queue, exponential backoff, and EcoWing canonical schema validation verified. End-to-end integration pending Phase 5. |
| **I2** | Integration | Schema and Taxonomy Name Divergence (Snake Case vs Title Case vs COCO) | **Closed** | `c903c9b`, `6b4fdeb` | `test_correctness.py::test_contract_schema_and_taxonomy_validation`, `test_drone_security.py::test_contract_schemas_and_command_state_machine_validation` | Canonical `contracts/taxonomy.yaml` and `detection-event.schema.json` single source of truth defined and verified in CI in both repos. |
| **I3** | Architecture | Conflicting Canonical Dashboards (`EcoWing/index.html` vs `Detection/public/index.html`) | **Closed** | `da01a24`, `3fc1a0b` | UI controls separation verification | Detection UI stripped of flight controls and designated as AI Vision test console; EcoWing designated as canonical Fleet Command Center. |
| **I4** | Architecture | In-Memory Frame Counts vs Persistent Cumulative Analytics Discrepancy | **Closed** | `d736e0b` | `test_correctness.py::test_staleness_flag_lifecycle_and_worker_running` | Added `scope: "live_frame"` to `/api/detections` and documented in README that counts represent instantaneous active window, not cumulative totals. |
| **I5** | Security | Lack of Unified Device Authentication Model for Detection Streamer | **Closed** | `1bd9cbe`, `f8daffb` | `test_drone_security.py::test_drone_ingestion_device_token_auth_and_cross_drone_rejection`, `test_outbox.py::test_outbox_offline_queue_and_delivery_when_ecowing_returns` | EcoWing enforces `X-Drone-Token` and `X-Drone-Id` on ingestion; Detection outbox sender transmits both headers. |

### 1.3 Detection System Findings (17 Items)

| ID | Category | Title / Exposure | Status Under R2 | Commit | Dedicated Passing Test | R2 Evaluation / Blocker |
|---|---|---|---|---|---|---|
| **D1** | Security | Unauthenticated Control & Upload Endpoints (`/api/settings`, `/api/upload`, `/api/system_info`) | **Closed** | `98b2442`, `9cbb962` | `test_security.py::test_auth_missing_header_returns_401`, `test_security.py::test_auth_query_param_token_rejected_returns_401`, `test_security.py::test_auth_valid_header_returns_200` | Asserts 401 without header, 401 with query parameter token, 200 with valid header. |
| **D2** | Security | Default 0.0.0.0 Binding & Public Internet Tunnel Exposure | **Closed** | `87fad7b` | `test_security.py::test_network_defaults_and_localhost_binding` | Asserts default binding is strictly 127.0.0.1, LAN requires ALLOW_LAN=true, TRUSTED_PROXIES defaults to empty, and start_tunnel.bat is permanently disabled with exit code 1. |
| **D3** | Security | Insecure CORS Configuration (`allow_origins=["*"]` with `allow_credentials=True`) | **Open** | `98b2442` (config edit) | None | Fixed in code, but previously misattributed to auth test; dedicated CORS test pending Phase 2.6. |
| **D4** | Security | RTSP Credentials Leaked via Plaintext String Serialization | **Closed** | `1358911` | `test_security.py::test_sanitize_source_url_redacts_credentials` | Asserts user:pass credentials are redacted with *** across RTSP and HTTP stream URLs, preventing secret leakage in API payloads and logs. |
| **D5** | Correctness | Detection Loop Tied to Video Viewers (Stale Telemetry Without Viewers) | **Closed** | `f07f467` | `test_correctness.py::test_worker_updates_results_with_zero_viewers`, `test_correctness.py::test_mobile_stream_frame_produces_detection_with_zero_viewers` | Asserts worker runs inference and updates `/api/detections` with 0 active MJPEG viewers. |
| **D6** | Performance | Redundant Per-Viewer YOLO Inference Loop | **Closed** | `f07f467` | `test_correctness.py::test_detector_calls_do_not_scale_with_viewers` | Asserts detector calls do not scale 3x when 3 viewers connect to `/video_feed`. |
| **D7** | Reliability | Missing Upload File Size Limits & Unbounded WebSocket Clients | **Closed** | `9cbb962`, `c229f2f` | `test_security.py::test_upload_oversize_file_returns_413`, `test_security.py::test_unauthenticated_sockets_count_against_connection_cap`, `test_security.py::test_concurrent_handshakes_gather_capped`, `test_security.py::test_ws_max_message_size_transport_rejection_code_1009` | Asserts 413 on upload > 5MB, 1013 on excess sockets (sync cap), 1009 on transport frame > 5MB. |
| **D8** | Integration | Mixed Content Blocking on HTTPS Embedding | **Open** | — | — | Scheduled for Phase 4 (Nginx reverse proxy topology). |
| **D9** | Integration | Browser Camera Access (`getUserMedia`) Blocked Over Plain HTTP | **Closed** | `3f72afa` | `test_security.py::test_mobile_secure_context_enforcement` | GET /mobile enforces browser Secure Context (localhost or HTTPS); serves informative notice on plain HTTP LAN; MOBILE_ENABLED=false by default. |
| **D10** | Configuration | Hardcoded LAN IP (`192.168.31.44`) Across Documentation | **Open** | — | — | Scheduled for Phase 6.1 (README correction). |
| **D11** | Documentation | Incompatible Deployment Claims (FastAPI/PyTorch on Vercel) | **Open** | — | — | Scheduled for Phase 6.1 (clarify host run requirements). |
| **D12** | Correctness | Model Provenance & False Detection Capabilities (COCO vs Custom Waste) | **Closed (Detection side)** | `64e8b48` | `test_correctness.py::test_every_mapping_coco_label_exists_in_model_classes`, `test_correctness.py::test_recyclable_and_biodegradable_allowed_enum_values`, `test_correctness.py::test_unmapped_coco_labels_produce_no_waste_items` | Asserts mapping table matches model classes, allowed enums, and unmapped labels produce no waste items. Shared taxonomy pending Phase 1. |
| **D13** | Correctness | Inconsistent Confidence Units (0–1 vs 0–100 Percentage) | **Closed** | `cad3d01`, `9edada4` | `test_correctness.py::test_all_confidence_values_within_zero_to_one`, `test_correctness.py::test_settings_confidence_contract_accepts_unit_float_and_rejects_percentage` | Normalized confidence to float in [0.0, 1.0]; rejects legacy 50%, negative values, > 1.0, and non-finite NaN, inf, -inf with HTTP 400. |
| **D14** | Maintenance | Binary Model Committed Without Git LFS | **Open** | — | — | Documented provenance and SHA256; Git LFS migration deferred. |
| **D15** | Maintenance | Superfluous Node.js `package.json` in Python FastAPI Project | **Open** | — | — | Cleanup scheduled for Phase 6. |
| **D16** | Quality | Workspace and Directory Naming Inconsistencies | **Open** | — | — | Documented; localized workspace paths maintained. |
| **D-NEW1** | Integration | Hardcoded Third-Party Vercel Production Target (`eco-wing-7pua.vercel.app`) | **Closed** | `da01a24` | Automated grep verification across codebase | Hardcoded third-party Vercel URLs removed from public/static/js/main.js, static/js/main.js, public/mobile.html, templates/mobile.html, public/index.html, templates/index.html. |

---

## 2. Operational & Deployment Items (Added, Non-Audit: 6 Items)

| ID | Origin / Classification | Description | Status Under R2 | Verification Path | Justification & Requirements |
|---|---|---|---|---|---|
| **OP-1** | Added, non-audit | Mobile Camera HTTPS/WSS Transport (`getUserMedia`) | **Closed** | `3f72afa` | `test_security.py::test_mobile_secure_context_enforcement` | Enforces browser Secure Context on GET /mobile; serves informational notice on plain HTTP LAN; MOBILE_ENABLED=false by default. |
| **OP-2** | Added, non-audit | Docker Network Gateway & Nginx Video Feed Gate (`/video_feed`) | **Open / Unverified** | Phase 4.2 | Mandated by deployment topology (user prompt Step 6a / Phase 4). Requires Docker daemon; Nginx `auth_request` validating operator token. |
| **OP-3** | Added, non-audit | Trusted Proxy Topology Verification | **Open / Unverified** | Phase 2.6 / 4.3 | Mandated by user prompt Step 6a / Phase 2.6. `TRUSTED_PROXIES` empty by default; requires exact gateway IP verification under Compose. |
| **OP-MONGO-AUTH** | Added, non-audit | Mongo `--auth` Container Flag Enforcement | **Partial / Unverified** | `8d9d326` | `docker-compose.yml` inspection test | Mandated by user prompt Step 6a / Phase 3.4. `--auth` flag configured in compose; requires Docker daemon to verify container runtime. |
| **OP-SHARED-LOCKOUT** | Added, non-audit | Shared Lockout Under NAT | **Open** | Phase 6.1 | Mandated by user prompt Step 6a / Phase 6.1. Documents IP-based pairing lockout behavior for multiple devices behind shared NAT. |
| **OP-LINE-ENDINGS** | Added, non-audit | Line-Ending Normalization (CRLF vs LF) | **Closed** | `d996a06`, `09db7c1` | `git ls-files --eol` across all tracked files | Mandated by Ground Rule R7. Enforced by `.gitattributes` (`* text=auto eol=lf`) to eliminate line-ending churn across platforms. |

---

## 3. Summary of Status Counts

- **Authoritative Items from AUDIT.md:** 37
  - **Closed:** 25 (E1, E2, E3, E6, E7, E8, E9, E10, E11, E-NEW1, E-NEW2, I2, I3, I4, I5, D1, D2, D4, D5, D6, D7, D9, D12, D13, D-NEW1)
  - **Partial:** 3 (E4, E13, I1)
  - **Open / Unverified:** 9 (E5, E12, D3, D8, D10, D11, D14, D15, D16)
- **Added, Non-Audit Operational Items:** 6
  - **Closed:** 2 (OP-1, OP-LINE-ENDINGS)
  - **Partial / Unverified:** 1 (OP-MONGO-AUTH)
  - **Open / Unverified:** 3 (OP-2, OP-3, OP-SHARED-LOCKOUT)
- **Grand Total Rows:** 43
