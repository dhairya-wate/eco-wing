# 🌱 EcoWing Waste Detection & Streaming System

A real-time AI computer vision software designed for the **EcoWing Project**. It detects waste items, classifies them into **Recyclable / Non-Recyclable** and **Biodegradable / Non-Biodegradable**, and streams live video directly to the EcoWing website over a local network or IP address.

---

## 🚀 Key Features

1. **Pretrained YOLO AI Detection:**
   - Uses standard 80-class COCO pretrained YOLO (`yolo26n.pt`).
   - Mapped COCO object classes are categorized into waste taxonomy items.
   - **Note:** The model does **NOT** directly detect materials such as paper, glass, cans, or plastic. Only recognized COCO objects (e.g. bottles, cups, cutlery, food scraps) are mapped to waste properties.
   - Strictly ignores unmapped non-waste classes (e.g. person, car, dog, chair).

2. **Dual-Axis Eco Classification:**
   - **Recyclable:** `YES` or `NO`
   - **Biodegradable:** `YES` or `NO`
   - **Disposal Recommendation:** Identifies the correct bin (Blue, Green, Yellow, Cyan, Landfill).

3. **High-Performance Website Live Streaming:**
   - Streams live annotated video over MJPEG (`/video_feed`).
   - Any website can embed it with a simple `<img>` tag without plugins or complex players.
   - Fully enabled with **CORS** for seamless cross-origin communication.

4. **Real-Time Telemetry & REST API:**
   - `/api/detections`: Live JSON feed of detected items, confidence scores, bounding boxes, and eco-counts.
   - `/ws`: High-speed WebSocket connection for live telemetry push.

5. **Built-in Web Control Hub (`http://<IP>:5000`):**
   - Live preview monitor with toggleable HUD overlay.
   - Dynamic confidence threshold slider.
   - Source switcher (Webcam 0, Webcam 1, Demo Simulator, RTSP stream, or video file).
   - Drag-and-drop test image analyzer.

---

## 📡 Live Stream & Website Connection Links

When the server is running on your machine:

| Feature | Endpoint URL | Auth Required | Description |
| :--- | :--- | :---: | :--- |
| **Web Dashboard** | `http://localhost:5000` | Optional | Browser control interface |
| **Video Stream URL** | `http://<IP>:5000/video_feed` | Public | Direct MJPEG video feed for website embed |
| **Telemetry API** | `http://<IP>:5000/api/detections` | Public | Live waste counts & classification JSON |
| **WebSocket** | `ws://<IP>:5000/ws` | Public | Low-latency live telemetry stream |
| **Settings Control** | `POST http://<IP>:5000/api/settings` | `X-Operator-Token` | Adjust confidence and video source |
| **Image Upload** | `POST http://<IP>:5000/api/upload` | `X-Operator-Token` | Upload image for waste analysis (max 5 MB) |
| **System Info** | `GET http://<IP>:5000/api/system_info` | `X-Operator-Token` | System configuration (redacted URLs) |
| **Mobile Pairing** | `POST http://<IP>:5000/api/mobile/pairing_code` | `X-Operator-Token` | Generate 6-char pairing code (5 min TTL) |
| **Code Exchange** | `POST http://<IP>:5000/api/mobile/exchange` | Public | Exchange pairing code for scoped session |
| **Mobile Stream WS** | `ws://<IP>:5000/ws/mobile_stream` | In-band session auth | Phone camera stream ingest |

> [!IMPORTANT]
> **API Contract Change Notice (`/api/detections` & `/api/system_info`):**
>
> 1. **Confidence Normalization (`/api/detections`):**
>    - **Old Contract:** `item.confidence` was returned as a percentage float between `0.0` and `100.0` (e.g. `94.5`).
>    - **New Contract:** `item.confidence` is now normalized to a standard unit float between `0.0` and `1.0` (e.g. `0.9450`).
>    - **Migration Notes:** Clients displaying confidence must format for display (e.g. `Math.round(item.confidence * 100)` in JS or `f"{conf*100:.1f}%"` in Python).
>
> 2. **Recyclable & Biodegradable Enums (`/api/detections`):**
>    - **Old Contract:** `item.recyclable` and `item.biodegradable` were booleans (`true`/`false`).
>    - **New Contract:** Now strict categorical enums: `"yes"`, `"no"`, `"estimated"`, `"depends"`, or `"unknown"`.
>    - **Migration Notes:** Update boolean checks from `if (item.recyclable)` to `['yes', 'estimated'].includes(item.recyclable)`.
>
> 3. **Additive & Restored Fields (`/api/detections`):**
>    - `timestamp`: Unix float epoch timestamp (e.g. `1793215978.123456`). Preserves original float type.
>    - `timestamp_iso`: ISO 8601 UTC string (e.g. `2026-11-01T07:35:12.345678+00:00`).
>    - `age_seconds`: Float indicating elapsed seconds since the latest inference update.
>    - `stale`: Boolean (`true` if `age_seconds > DETECTION_STALE_AFTER_SECONDS` [default 5s]).
>    - `data.taxonomy_version`: Currently `"1.0.0"`.
>    - `data.classification_method`: `"coco_mapping"`.
>    - `item.coco_label`: Ground-truth COCO class label.
>    - `item.material`: Material string (defaults to `"unknown"` unless determined by a material model).
>    - `item.model_supported`: Boolean `true`.
>
> 4. **Confidence Unit on Settings (`POST /api/settings`):**
>    - `confidence`: Accepts standard unit float in `[0.0, 1.0]` (e.g. `0.5` sets 50% threshold).
>    - Legacy percentage values (`50`) and out-of-range floats are strictly rejected with HTTP 400 Bad Request.
>
> 5. **System Info & Worker Status (`/api/system_info`):**
>    - `worker_running`: Boolean indicating whether background detection worker thread is actively processing frames.
>    - Strictly requires `X-Operator-Token` header. Query parameter `?token=` is rejected with HTTP 401.

---

## 🔒 Security & Operator Authentication

1. **Deployment Architecture Decision:**
   - **Local Behind Nginx:** EcoWing and Detection are designed to run locally on-premises or on a field computer behind Nginx.
   - **Remote Access via VPN:** Remote monitoring or mobile connections outside the local LAN must use an encrypted VPN (e.g. WireGuard, Tailscale). Never expose raw ports to the public internet.
   - **Vercel Demo Notice:** The public Vercel frontend is an unlinked static preview. It does not connect to the local backend due to HTTPS Mixed Content restrictions.

2. **Operator Authorization & Fail-Fast Startup:**
   - Detection requires `DETECTION_OPERATOR_TOKEN` to be set to a cryptographically secure token of at least 32 characters.
   - The token must contain at least 12 distinct characters and must not consist of repeated periodic patterns (e.g. `"abcd" * 9` or `"a" * 36`).
   - The server fails fast on startup with a critical error if the token is unset, shorter than 32 characters, or repetitive.
   - Sensitive endpoints (`/api/settings`, `/api/upload`, `/api/system_info`, `/api/mobile/pairing_code`) strictly require the `X-Operator-Token` header.

3. **Hardened Mobile Camera Pairing Flow & Secure Context Transport:**
   - **Secure Context Requirement:** Camera access via `navigator.mediaDevices.getUserMedia` strictly requires a W3C Secure Context (`window.isSecureContext === true`). Modern web browsers treat only `https://` origins and `http://localhost` / `http://127.0.0.1` as secure contexts. Plain HTTP connections over a LAN (e.g. `http://192.168.1.X:5000/mobile`) block camera access completely.
   - Consequently, remote mobile streaming requires HTTPS (via an Nginx/Caddy TLS reverse proxy or secure tunnel).
   - Mobile streaming is **disabled by default** (`MOBILE_ENABLED=false`). Set `MOBILE_ENABLED=true` in `.env` to enable it.
   - To prevent leaking operator credentials to phone browsers, the operator generates an 8-character pairing code from an unambiguous alphabet via `POST /api/mobile/pairing_code`.
   - The phone exchanges this code at `POST /api/mobile/exchange` for a single-purpose, scoped `session_token`.
   - Failed exchange attempts are tracked per client IP; 5 failed attempts locks out the client IP address for 10 minutes (`{"detail": "Too many failed pairing attempts. IP address locked out for 10 minutes."}`, HTTP 429).
   - **Shared-NAT & Proxy Behavior:** When multiple mobile devices share a public IP (behind corporate NAT, mobile carrier NAT, or an unconfigured reverse proxy), an IP lockout applies to all devices sharing that IP for the 10-minute lockout window. When the lockout expires, failed attempt counters reset to 0, so a single subsequent failed exchange will not immediately re-lock the IP. Legitimate operators should configure `TRUSTED_PROXIES` so client IPs are reliably resolved from `X-Forwarded-For`.
   - In-band WebSocket authentication: The phone connects to `/ws/mobile_stream` (no token in the URL) and sends `{"type":"auth","session":"..."}` as its first message.
   - Connection caps count both pending (unauthenticated) and active sockets against `MAX_MOBILE_WS_CONNECTIONS` (default: 5), synchronously registering sockets before any async dispatch and returning WebSocket close code `1013` with fixed reason `"Try again later: Mobile connection limit reached"` when capped.
   - The session token is consumed immediately upon successful WebSocket connect to prevent socket replay attacks.
   - Close frame reason phrases are strictly limited to fixed strings <= 123 bytes per RFC 6455. Server exceptions are logged server-side only with generic reason `"Internal server error: Frame ingestion failed"` sent to the client (code 1011).

4. **Network Topology & Trusted Proxies:**
   - `DETECTION_TRUSTED_PROXIES` defaults to `""` (empty list; direct socket peer is always used).
   - **Proxy-forwarded IPs (X-Forwarded-For) are unsupported until verified.** When `DETECTION_TRUSTED_PROXIES` is empty, incoming `X-Forwarded-For` headers are strictly ignored and client IP is resolved from the socket peer directly.
   - **Nginx-to-Detection Path Status:** **UNVERIFIED** (Docker is unavailable on test environment).
   - If deploying with Docker Compose on a supported Docker host, manual verification can be performed using `wget` inside the container (using `wget`, not `curl`, as Alpine Nginx includes `wget`):
     ```bash
     docker compose exec web wget -qO- \
       --header="X-Operator-Token: $DETECTION_OPERATOR_TOKEN" \
       http://host.docker.internal:5000/api/system_info
     ```
   - Security topology rule: Trust ONLY the exact gateway IP when configuring `DETECTION_TRUSTED_PROXIES`, never whole subnets or DNS names (to prevent DNS spoofing and cross-container IP spoofing).
   - `X-Forwarded-For` is honored only when requests originate directly from an exact IP configured in `DETECTION_TRUSTED_PROXIES`. Untrusted peer requests ignore `X-Forwarded-For` and use the direct peer socket IP.

5. **Security Error Responses Contract (`app.py` Source of Truth):**
   - **HTTP 401 Unauthorized:**
     - `Unauthorized: invalid or missing operator token. Provide 'X-Operator-Token' header.` (Triggered when `X-Operator-Token` header is missing, invalid, or passed via query parameter).
     - `Invalid or expired pairing code.` (Triggered on `POST /api/mobile/exchange` when pairing code is invalid or past 300s TTL).
   - **HTTP 413 Request Entity Too Large:**
     - `Upload size ({declared_cl} bytes) exceeds maximum allowed limit of 5 MB.` (Triggered on declared `Content-Length` header > 5 MB).
     - `Upload size ({file_size} bytes) exceeds maximum allowed limit of 5 MB.` (Triggered on ASGI file.size > 5 MB).
     - `Upload size exceeds maximum allowed limit of 5 MB.` (Triggered when chunked payload stream exceeds 5 MB).
   - **HTTP 429 Too Many Requests:**
     - `IP temporarily locked out due to excessive failed exchange attempts. Try again in {seconds}s.` (Triggered on `POST /api/mobile/exchange` during active 10-minute IP lockout).
     - `Too many pairing exchange requests. Please slow down.` (Triggered on `POST /api/mobile/exchange` exceeding sliding window rate limit of 10 req/min per IP).
     - `Too many failed pairing attempts. IP address locked out for 10 minutes.` (Triggered on the 5th consecutive failed pairing exchange attempt from an IP).

6. **Canonical Server Launch Command:**
   - The production server command enforcing host, port, and the 5 MB WebSocket transport message limit is:
     ```bash
     uvicorn app:app --host 127.0.0.1 --port 5000 --ws-max-size 5242880
     ```
   - The `--ws-max-size 5242880` argument sets the enforced transport frame limit at the ASGI layer.

7. **Development Internet Tunnel (`start_tunnel.bat`):**
   - `start_tunnel.bat` is strictly for **development and testing**.
   - Running the tunnel exposes port 5000 to the public internet. Read-only endpoints (`/video_feed`, `/api/detections`, `/ws`) become publicly accessible.
   - Requires explicit opt-in: `set ALLOW_TUNNEL=1`.

---

## ⚖️ Model Limitations & AGPL-3.0 License Notice

- **Third-Party Dependency:** This server uses [Ultralytics YOLO](https://github.com/ultralytics/ultralytics), licensed under **AGPL-3.0**. See [`NOTICE`](./NOTICE) for details.
- **Classification Limitations:** The shipped weights (`yolo26n.pt`) are standard 80-class COCO weights. Detected items are mapped to waste taxonomy categories via heuristic config tables. Custom-trained model weights for paper, cardboard, and industrial waste will be introduced in future updates.

---

## 💻 How to Connect to the EcoWing Website

### 1. In Plain HTML
Simply paste this image tag into your website's HTML template:
```html
<div class="stream-container">
  <h3>EcoWing AI Live Detection Feed</h3>
  <img 
    src="http://192.168.31.44:5000/video_feed" 
    alt="EcoWing Waste Detection Stream" 
    style="width: 100%; max-width: 800px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);"
  />
</div>
```

### 2. In React / Next.js
```jsx
export default function WasteStreamWidget() {
  const streamUrl = "http://192.168.31.44:5000/video_feed";

  return (
    <div className="p-4 bg-gray-900 rounded-2xl shadow-xl">
      <h2 className="text-emerald-400 font-bold mb-3">EcoWing Live Sorting Stream</h2>
      <img 
        src={streamUrl} 
        alt="EcoWing Stream" 
        className="w-full rounded-xl border border-emerald-500/20 shadow-md"
      />
    </div>
  );
}
```

### 3. Fetching Real-Time Waste Counters in JavaScript
```javascript
// Poll current waste counts and items every 1 second
async function fetchEcoWingStats() {
  try {
    const res = await fetch("http://192.168.31.44:5000/api/detections");
    const json = await res.json();
    const data = json.data;

    console.log(`Total Waste: ${data.total_count}`);
    console.log(`Recyclable: ${data.recyclable_count}`);
    console.log(`Biodegradable: ${data.biodegradable_count}`);
    
    // List of individual items in view
    data.items.forEach(item => {
      const pct = Math.round(item.confidence * 100);
      console.log(`${item.name} (${pct}%): Recyclable=${item.recyclable}, Bio=${item.biodegradable}`);
    });
  } catch (err) {
    console.error("EcoWing Server Offline:", err);
  }
}

setInterval(fetchEcoWingStats, 1000);
```

---

## 🗂️ COCO-to-Waste Mapping Table (`config.COCO_WASTE_MAPPING`)

> [!NOTE]
> The detector uses standard 80-class COCO weights (`yolo26n.pt`). It does **NOT** detect raw materials (such as loose paper, broken glass, scrap metal, or raw plastic) directly.
> Only recognized COCO object classes are mapped to waste categories and disposal properties using the table below (Taxonomy v1.0.0, classification method `coco_mapping`).
> Any COCO class not present in this mapping table is strictly ignored and never reported as waste.

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

## 🏃 How to Run the Detection Server

In your terminal inside `detction system`:

```bash
python run.py
```
Or with custom port:
```bash
python -m uvicorn app:app --host 0.0.0.0 --port 5000
```

Open `http://localhost:5000` or `http://192.168.31.44:5000` in any web browser to view the control center.

