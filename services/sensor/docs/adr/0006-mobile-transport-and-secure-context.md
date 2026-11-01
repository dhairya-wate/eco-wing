# ADR 0006: Mobile Camera Transport, Secure Context, and Pairing Security

## Status
Accepted

## Context
Detection provides a mobile web streamer (`/mobile` and `/ws/mobile_stream`) allowing smartphones to act as edge camera sensors:
1. Modern web browsers (Chrome, Safari, Firefox) strictly restrict the `navigator.mediaDevices.getUserMedia` API to **Secure Contexts** (HTTPS or `localhost`). Accessing `/mobile` over plain HTTP on a local LAN IP (e.g. `http://192.168.1.50:5000/mobile`) causes browser security exceptions where camera permissions are silently denied or blocked.
2. The mobile WebSocket endpoint (`/ws/mobile_stream`) was previously unauthenticated, allowing any device on the network to inject fake video frames into the detection pipeline.
3. Multiple mobile streamers operating behind a shared NAT router could suffer collateral lockouts if authentication rate-limiting is keyed solely by remote IP address.

## Decision
1. **Secure Context Enforcement**: The mobile web streamer enforces browser Secure Contexts.
   - `MOBILE_ENABLED=false` by default.
   - When accessed over plain HTTP on LAN, the server delivers an informational warning explaining that `getUserMedia` requires HTTPS or localhost.
   - Production mobile streaming requires TLS (HTTPS / WSS) via reverse proxy.
2. **Session Authentication & Rate Limiting**:
   - Mobile streaming requires an authenticated session handshake (`X-Operator-Token` or pre-shared session token) before WebSocket frame ingestion is accepted.
   - Binary frames sent before authentication immediately close the socket with code 1008 (Policy Violation).
   - Maximum WebSocket frame size is capped at 5 MB (code 1009 on overflow).
3. **Shared NAT Pairing & Lockout Architecture**:
   - To prevent multiple field devices behind a single mobile carrier NAT from locking each other out, authentication rate limiting is decoupled from transport IP and keyed by device session token (`X-Drone-Token`, `session_id`).
   - Failed authentication attempts on a specific device token do not lock out distinct tokens originating from the same NAT gateway.

## Consequences
- **Positive**: Complies with browser W3C Secure Context specifications; secures mobile camera ingestion against unauthorized injection; prevents shared NAT lockout issues.
- **Negative**: Field testing mobile phone camera feeds over local Wi-Fi requires either a localhost tunnel (e.g. adb reverse) or a local TLS certificate.
