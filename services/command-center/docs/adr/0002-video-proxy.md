# ADR 0002: Video Feed Reverse-Proxy Architecture & Security Gate

## Status
Accepted

## Context
Detection emits an MJPEG stream over HTTP multipart responses at `/video_feed` on port 5000.
When operators access the EcoWing dashboard over HTTPS or when deploying in a containerized environment:
1. Embedding plain HTTP video (`http://host:5000/video_feed`) inside an HTTPS dashboard results in browser **Mixed Content Blocking** (`ERR_INSECURE_CONTENT`).
2. Directly publishing port 5000 to the public host or internet allows unauthenticated adversaries to intercept live camera footage without passing through operator authentication or rate limiting.
3. Node.js Express is poorly suited for proxying long-running persistent MJPEG multipart streams (can block the single-threaded event loop or exhaust memory buffers).

## Decision
We route all client-facing video streaming through an **Nginx Reverse Proxy** running on port 8080:
1. **Network Boundary**: Detection (port 5000) and EcoWing backend (port 3000) are unmapped from the host network in production compose and communicate solely over an internal Docker bridge network (`ecowing_net`).
2. **Operator Gate**: Nginx gates access to `/video_feed` by verifying the presence of `X-Operator-Token` via `$http_x_operator_token`. Unauthenticated requests are rejected at the edge with HTTP 401 Unauthorized before reaching Python.
3. **Buffering Disabled**: Nginx disables proxy buffering (`proxy_buffering off;`, `proxy_cache off;`) and extends timeouts (`proxy_read_timeout 86400s;`) to allow continuous chunked multipart frame delivery.
4. **Relative Path Resolution**: Detection's `/api/system_info` endpoint respects `X-Forwarded-Proto` and `X-Forwarded-Host` and supplies relative paths (`/video_feed`, `/api/detections`) so the client dashboard embeds video same-origin over TLS without mixed content errors.

## Consequences
- **Positive**: Eliminates mixed content errors; protects live drone camera feed with operator token verification; shields Python/Node runtimes from direct exposure.
- **Negative**: Deployments requiring video feed access must route through Nginx or provide operator authentication headers in stream requests.
