# ADR 0007: Three-Tier Token Architecture & Edge Device Lifecycle

## Status
Accepted

## Context
EcoWing connects autonomous drones and field mobile camera sensors to an operator command center. Previously:
1. Drone device authentication relied strictly on static environment variables (`DRONE_DEVICE_TOKENS`, `DRONE_TOKEN_<ID>`), requiring server restarts and config redeployments to add, rotate, or revoke devices.
2. Mobile phone streaming generated ephemeral 8-character pairing codes entirely in-memory within the detection service, decoupled from EcoWing's central device registry and command center.
3. Token revocation for mobile sensors was not centrally orchestratable by the command center operator, and multiple instances could not synchronize pairing state or active sessions.

## Decision

1. **Three-Tier Cryptographic Token Architecture**:
   - **Device Token (Tier 1 - Long-Lived)**:
     - Issued by EcoWing when an operator registers a physical drone or mobile sensor device.
     - Shown to the operator exactly once; never logged or stored in plaintext.
     - Stored exclusively as a cryptographic SHA-256 hash in the database.
     - Can be rotated or revoked by the operator at any time.
     - Edge sensors use this token to authenticate detection outbox deliveries to `POST /api/drone/detection`.
   - **Pairing Code (Tier 2 - Short-Lived Exchange)**:
     - 6 characters chosen securely from the unambiguous 32-character alphabet:
       `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (entropy: $32^6 \approx 1.07 \times 10^9$ combinations).
     - Generated on demand by EcoWing, associated with a registered device, valid for 5 minutes (enforced via MongoDB TTL index).
     - Single-use: burned immediately upon successful exchange.
     - Rate-limited: after 5 incorrect exchange attempts against any code, the code is permanently burned.
   - **Session Token (Tier 3 - Scoped Ephemeral)**:
     - Opaque cryptographically random token (minimum 32 bytes) issued upon pairing code exchange.
     - **Opaque Random vs. Signed Tokens (JWT)**: We explicitly chose **opaque random tokens stored as hashes** over signed tokens (such as JWT). Signed tokens cannot be revoked immediately across distributed edge instances without maintaining a revocation blocklist whose complexity equals that of an opaque session store. Opaque random tokens allow instantaneous revocation from the EcoWing command center.
     - Stored as SHA-256 hash with ~1 hour TTL in MongoDB (with automatic expiration index).
     - Scoped strictly to camera frame streaming and command receipt.

2. **Storage and Service Isolation**:
   - Devices, pairing codes, and sessions are persisted in MongoDB with automatic TTL indexes (`expireAfterSeconds: 0`), surviving restarts and scaling across multiple instances.
   - Secret comparisons are strictly executed using constant-time algorithms (`crypto.timingSafeEqual` in Node.js, `secrets.compare_digest` in Python) to prevent timing side-channels.
   - Detection service authenticates to EcoWing via dedicated `DETECTION_SERVICE_TOKEN` on `POST /api/mobile/verify_code`. The operator token (`X-Operator-Token`) never leaves EcoWing and is never exposed to mobile web clients.
   - Unified revocation endpoint across both services: `POST /api/mobile/revoke-session`.

3. **API Contracts, Data Masking & Command Routing**:
   - **`GET /api/devices` Metadata Only Response Contract**:
     - To prevent credential leakage, `GET /api/devices` returns metadata only: `id`, `device_id`, `name`, `type`, `status`, `created_at`, `revoked_at`, and `fingerprint` (the first 8 hex characters of the SHA-256 `token_hash`).
     - **Strict Security Guarantee**: The full `token_hash` and raw `device_token` are **NEVER** returned in device listings or logs. Raw tokens are only exposed once in the payload of `POST /api/devices` (or token rotation).
   - **Unified Command Endpoint**:
     - All commands for drones and phone sensors are dispatched exclusively via `POST /api/drone/command` with a `target` discriminator (`"drone"` or `"phone"`). `POST /api/device/command` is deprecated and removed.
     - Flight commands (`start`, `hold`, `rth`, `land`, `estop`) are gated by telemetry freshness and sent to the drone channel.
     - Phone stream commands (`pause_stream`, `resume_stream`, `set_confidence`) are validated against schema constraints and dispatched to the phone channel.
   - **Public QR Code Derivation**:
     - Mobile pairing URLs and QR codes are generated dynamically using `ECOWING_PUBLIC_URL` at `/mobile?code=...`.
     - When `ECOWING_PUBLIC_URL` is unset, the server returns `mobile_url: null` and the dashboard displays a clear configuration warning instead of generating a QR code. No external or third-party host is hardcoded.

4. **Backward Compatibility & Ingestion Migration**:
   - Existing drone tokens configured via `DRONE_DEVICE_TOKENS` and `DRONE_TOKEN_<ID>` continue to function through a transparent fallback in `verifyDroneToken`, ensuring zero interruption to in-flight drone telemetry.
   - A one-time startup deprecation warning is logged when `DRONE_DEVICE_TOKENS` is present, without logging any token values.
   - A toggle flag `LEGACY_ENV_TOKENS_ENABLED` (default: `true`) permits operators to disable environment token fallbacks entirely once migration is verified.
   - A database migration script (`migrateDroneTokens()`) transfers environment tokens into the `Device` collection with SHA-256 hashing. Devices registered in the database authenticate solely through constant-time comparison of `token_hash` and never invoke the legacy fallback.

## Consequences
- **Positive**: Provides enterprise-grade device governance; prevents credential replay and token exposure; enables instant session revocation; allows dynamic phone and drone registration without restarting command center services.
- **Negative**: Requires database connectivity (or local persistent fallback) to persist device registrations and validate active sessions.
