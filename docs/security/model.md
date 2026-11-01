# Security Model & Trust Boundaries

## Authentication & Authorization Gates

1. **Operator Privileged Endpoints**:
   - Protected by `X-Operator-Token` header.
   - Enforced on `/api/drone/command`, `/api/camera/command`, `/api/drone/connect`, `/api/drone/disconnect`, `/video_feed`, `/api/feed/clear`, `/api/export/csv`, `/api/export/json`.
   - Constant-time comparison via `crypto.timingSafeEqual`.

2. **Drone Device Token Authentication**:
   - Per-drone token isolation (`X-Drone-Token`).
   - Cross-drone device token mismatch rejected with 401.

3. **Sensor-to-Backend Bridge (Outbox)**:
   - Server-to-server push from sensor to EcoWing backend `/api/drone/detection`.
   - Idempotency key `event_id` enforced with deduplication.

4. **Network Hardening & Proxies**:
   - Default allowlist prevents SSRF to unauthorized LAN hosts.
   - Trusted proxy CIDR verification prevents `X-Forwarded-For` spoofing.
