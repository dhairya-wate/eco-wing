# 🌱 EcoWing Waste Detection & Edge Sensor System

A high-performance real-time AI computer vision system designed for the **EcoWing Autonomous Drone Fleet**. It runs on drone companion computers and field edge nodes to detect waste items, perform dual-axis classification (**Recyclable** and **Biodegradable**), and stream structured telemetry and live annotated video to the **EcoWing Command Center**.

---

## 🏗️ System Architecture & Data Flow

```mermaid
flowchart TD
    subgraph EdgeDevice["Drone Companion Computer / Edge Sensor Node (Detection System)"]
        Cam["Physical Camera / Mobile Streamer"] -->|Frames| StreamMgr["VideoStreamManager"]
        StreamMgr -->|Capped FPS| Worker["DetectionWorker (Background Thread)"]
        Worker -->|Inference (Outside Lock)| YOLO["WasteDetector (YOLOv8 Nano: yolo26n.pt)"]
        YOLO -->|Taxonomy Filter| MapTable["COCO-to-Waste Mapping (contracts/taxonomy.yaml)"]
        MapTable -->|Canonical Events| OutboxQ["OutboxQueue (Persistent SQLite: outbox.db)"]
        OutboxQ -->|X-Drone-Token Auth| OutboxSender["OutboxSender (Exponential Backoff)"]
        Worker -->|Latest JPEG Under Lock| MJPEG["MJPEG Generator (/video_feed)"]
    end

    subgraph ProxyGateway["Reverse-Proxy Security Boundary (Port 8080)"]
        Nginx["Nginx Reverse Proxy"]
        Gate["X-Operator-Token Auth Gate"]
    end

    subgraph CommandCenter["Command Center (EcoWing Repository)"]
        Ingest["EcoWing Ingestion API (/api/drone/detection)"]
        Store["Idempotent Storage (DetectionStore / MongoDB)"]
        Dash["Pilot Dashboard (HTML / Socket.IO)"]
    end

    OutboxSender -->|Canonical HTTP POST| Ingest
    Ingest --> Store
    Store --> Dash
    MJPEG --> Gate
    Gate --> Nginx
    Nginx -->|Same-Origin Stream| Dash
```

---

## 🔒 Trust Boundaries & Network Topology

| Component | Network Binding | Default Host/Port | Access Rule & Authentication | Trust Boundary |
| :--- | :--- | :--- | :--- | :--- |
| **Detection API** | Localhost only | `127.0.0.1:5000` | Loopback only. LAN requires `ALLOW_LAN=true`. | Internal loopback / Edge container |
| **Operator Endpoints** | Localhost / Nginx | `/api/settings`, `/api/upload`, `/api/system_info` | Strictly requires `X-Operator-Token` header (min 32 chars). | Trusted Operator |
| **Outbox Egress** | Client HTTP Egress | Outbound to EcoWing `/api/drone/detection` | Strictly transmits `X-Drone-Token` and `X-Drone-Id`. | Authenticated Drone Telemetry Link |
| **Mobile Stream Ingest** | Localhost / Nginx | `/mobile`, `/ws/mobile_stream` | Enforces browser Secure Context; in-band session token required. | Field Mobile Sensor |
| **Video Stream** | Localhost / Nginx | `/video_feed` | Gated by Nginx reverse proxy with operator authentication. | Edge-to-Proxy Stream |

---

## 🚀 Key Architectural Capabilities

1. **Edge Inference with Structured Outbox Push (ADR 0003):**
   - Inference runs locally on edge companion computers using a dedicated background worker (`worker.py`).
   - Rather than saturating wireless drone links by streaming continuous raw video for centralized processing, Detection pushes compact JSON detection events (~1 KB) to EcoWing.
   - Events are buffered locally in an SQLite persistent outbox queue (`outbox.db`). If wireless signal is lost, events are preserved and delivered automatically with exponential backoff upon reconnection.

2. **Decoupled Background Inference Worker:**
   - Dedicated `DetectionWorker` runs at a fixed, configurable frame rate governed by `DETECTION_MAX_FPS` (default 30.0 FPS).
   - Inference executes **outside** the worker thread lock, ensuring that API readers and MJPEG viewers are never blocked by PyTorch or OpenCV computations.
   - Inference does not scale with viewer connections; 0 viewers or 10 viewers consume identical compute resources.

3. **Pretrained YOLO AI Detection & Model Provenance (D14):**
   - **Model Binary:** `yolo26n.pt`
   - **Base Architecture:** YOLOv8 Nano (Ultralytics) trained on base 80-class COCO.
   - **Model Checksum (SHA256):** `9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef`
   - **Provenance Note:** The model detects standard COCO objects. It does **NOT** directly detect materials like raw plastic, glass, or paper. Only recognized COCO objects are mapped to waste properties via `config.COCO_WASTE_MAPPING`.
   - Unmapped non-waste classes (e.g. `person`, `car`, `dog`) are suppressed and never reported as waste.

4. **Dual-Axis Eco Classification:**
   - **Recyclable:** `"yes"`, `"no"`, `"estimated"`, `"depends"`, or `"unknown"`
   - **Biodegradable:** `"yes"`, `"no"`, `"estimated"`, `"depends"`, or `"unknown"`
   - **Disposal Recommendation:** Directs waste to designated bin categories (Blue, Green, Yellow, Cyan, Mixed).

---

## 📡 Endpoints & Integration Interface

| Feature | Endpoint URL | Auth Required | Description |
| :--- | :--- | :---: | :--- |
| **Web Diagnostic Hub** | `http://localhost:5000` | Optional | Edge sensor visual diagnostic interface |
| **Video Stream URL** | `http://localhost:8080/video_feed` | Operator Token (via Proxy) | MJPEG live stream for web dashboard embedding |
| **Telemetry API** | `http://localhost:5000/api/detections` | Public (Read-only) | Instantaneous active frame waste counts & JSON metadata |
| **WebSocket** | `ws://localhost:5000/ws` | Public | Live telemetry broadcast socket |
| **Settings Control** | `POST /api/settings` | `X-Operator-Token` | Adjust confidence unit float (`[0.0, 1.0]`) and input source |
| **Image Upload** | `POST /api/upload` | `X-Operator-Token` | Upload test image for waste analysis (max 5 MB) |
| **System Info** | `GET /api/system_info` | `X-Operator-Token` | System configuration (redacted URLs, relative paths) |
| **Mobile Pairing** | `POST /api/mobile/pairing_code` | `X-Operator-Token` | Generate 6-char pairing code (5 min TTL) |
| **Code Exchange** | `POST /api/mobile/exchange` | Public | Exchange pairing code for scoped session |
| **Mobile Stream WS** | `ws://localhost:5000/ws/mobile_stream` | In-band session auth | Phone camera stream ingest |

---

## 🔒 Security Architecture & Guardrails

1. **Operator Authorization (`DETECTION_OPERATOR_TOKEN`):**
   - Startup validation enforces a minimum of 32 characters, 12 unique characters, and non-repeating entropy.
   - If unset or weak, the service fails fast and refuses to boot.
   - Sensitive control endpoints (`/api/settings`, `/api/upload`, `/api/system_info`, `/api/mobile/pairing_code`) require `X-Operator-Token`.

2. **Default Localhost Binding & Tunnel Elimination (D2):**
   - Server binds strictly to `127.0.0.1` by default. Binding to `0.0.0.0` requires explicit `ALLOW_LAN=true`.
   - Insecure third-party tunnels (`start_tunnel.bat`) have been permanently disabled with exit code 1.

3. **CORS Allowlist Validation (D3):**
   - Wildcard CORS (`*`) with credentials is removed.
   - Allowed origins default to `http://localhost:8080`, `http://127.0.0.1:8080`, `http://localhost:5000`, `http://127.0.0.1:5000`, configurable via `CORS_ORIGINS`.

4. **Credential Redaction in Stream URLs (D4):**
   - Embedded RTSP and HTTP stream credentials (`rtsp://user:pass@host/`) are automatically scrubbed and redacted as `***` in API responses and server logs.

5. **Transport Limits & Buffer Protection (D7):**
   - Upload file size is strictly capped at 5 MB (HTTP 413 Payload Too Large on overflow).
   - Concurrent unauthenticated WebSocket handshakes are capped at 5, and total sockets are capped at 10.
   - Transport frame size is capped at 5 MB (WebSocket close code 1009).

6. **Mobile Secure Context Enforcement & NAT Pairing (D9, OP-SHARED-LOCKOUT):**
   - Mobile camera streaming (`/mobile`) enforces browser Secure Contexts (`HTTPS` or `localhost`).
   - Plain HTTP access over LAN serves an informative security notice explaining that `getUserMedia` camera access requires HTTPS.
   - Mobile authentication rate limiting is decoupled from transport IP address and keyed by session token, ensuring multiple phones behind a shared NAT router do not suffer collateral pairing lockouts.

7. **Vercel Demo Notice (D11):**
   - The public Vercel frontend is an unlinked static demonstration preview.
   - Full Detection inference requires a Python host runtime with PyTorch and OpenCV; it cannot run on static/serverless Vercel hosting.

---

## 🗂️ COCO-to-Waste Mapping Table (`config.COCO_WASTE_MAPPING`)

> [!NOTE]
> The detector uses standard 80-class COCO weights (`yolo26n.pt`). It does **NOT** detect raw materials directly. Only recognized COCO objects are resolved to waste categories (Taxonomy v1.0.0, method `coco_mapping`). Unmapped classes produce no waste items.

| COCO Label | Category | Material | Recyclable | Biodegradable | Method | Model Supported | Recommended Bin |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| `bottle` | Container | unknown | depends | no | coco_mapping | true | Blue / Cyan Bin (Plastics/Glass) |
| `cup` | Container | unknown | depends | depends | coco_mapping | true | Yellow / Blue Bin (Metals/Paper) |
| `wine glass` | Glassware | unknown | yes | no | coco_mapping | true | Cyan Bin (Glass) |
| `fork` | Cutlery | unknown | depends | no | coco_mapping | true | Yellow / Blue Bin |
| `knife` | Cutlery | unknown | depends | no | coco_mapping | true | Yellow / Blue Bin |
| `spoon` | Cutlery | unknown | depends | no | coco_mapping | true | Yellow / Blue Bin |
| `bowl` | Container | unknown | depends | no | coco_mapping | true | Mixed Waste Bin |
| `banana` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `apple` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `sandwich` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `orange` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `broccoli` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `carrot` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `hot dog` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `pizza` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `donut` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `cake` | Organic | unknown | no | yes | coco_mapping | true | Green Bin (Compost) |
| `book` | Paper/Reading | unknown | yes | yes | coco_mapping | true | Blue Bin (Paper/Dry) |

---

## 🏃 Run Paths & Execution Instructions

### Local Development Run Path
1. Set mandatory operator token:
   ```bash
   export DETECTION_OPERATOR_TOKEN="your_secure_operator_token_at_least_32_chars_long_123"
   export ECOWING_INGEST_URL="http://127.0.0.1:3000/api/drone/detection"
   export ECOWING_DEVICE_TOKEN="your_drone_token_configured_in_ecowing"
   ```
2. Start the service:
   ```bash
   python -m uvicorn app:app --host 127.0.0.1 --port 5000
   ```
3. Open `http://localhost:5000` to inspect local diagnostic hub.

### Docker Compose Run Path
When deploying with EcoWing stack:
- Detection runs as an internal service on the `ecowing_net` Docker bridge.
- All client access routes through Nginx on port `8080`.
