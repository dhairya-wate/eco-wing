# EcoWing Detection System — Security, Correctness & Integration Audit

**Date:** 2026-11-01  
**Repository:** `Detection` (`github.com/dhairya-wate/Detection`)  
**Workspace Path:** `C:\Users\Anshu\Desktop\mini-project\detction system`  
**Target Architecture:** FastAPI Python backend running YOLO inference, MJPEG video streaming, and real-time telemetry APIs.

---

## Executive Summary

An in-depth security, correctness, and architecture audit was performed across all source files in the Detection repository. The audit revealed significant safety and security exposures—notably unauthenticated control and upload endpoints, control panel binding to `0.0.0.0` with arbitrary public tunneling via `localtunnel`, invalid CORS configurations, plaintext credential leakage, and severe inference bottlenecks where detection runs redundantly per video viewer rather than once in a dedicated background worker.

---

## Audit Findings Matrix

| ID | Category | Severity | Status | File(s) & Lines | Title / Issue |
|---|---|---|---|---|---|
| **D1** | Security | **CRITICAL** | **CONFIRMED** | `app.py:147-179, 212-240` | Unauthenticated Control & Upload Endpoints |
| **D2** | Security | **HIGH** | **CONFIRMED** | `config.py:10`, `app.py:261`, `start_tunnel.bat:9` | Default 0.0.0.0 Binding & Public Internet Tunnel Exposure |
| **D3** | Security | **HIGH** | **CONFIRMED** | `app.py:33-39` | Insecure CORS Configuration (`allow_origins=["*"]` with `allow_credentials=True`) |
| **D4** | Security | **HIGH** | **CONFIRMED** | `app.py:122-137, 147-159` | RTSP Credentials Leaked via Plaintext String Serialization |
| **D5** | Correctness | **HIGH** | **CONFIRMED** | `app.py:71-120` | Detection Loop Tied to Video Viewers (Stale Telemetry Without Viewers) |
| **D6** | Performance | **HIGH** | **CONFIRMED** | `app.py:71-112` | Redundant Per-Viewer YOLO Inference Loop |
| **D7** | Reliability | **MEDIUM** | **CONFIRMED** | `app.py:161-179, 181-201` | Missing Upload File Size Limits & Unbounded WebSocket Clients |
| **D8** | Integration | **MEDIUM** | **CONFIRMED** | `app.py:125-144`, `README.md:58-80` | Mixed Content Blocking on HTTPS Embedding |
| **D9** | Integration | **MEDIUM** | **CONFIRMED** | `public/mobile.html:477`, `templates/mobile.html:477` | Browser Camera Access (`getUserMedia`) Blocked Over Plain HTTP |
| **D10** | Configuration | **LOW** | **CONFIRMED** | `README.md:41-47, 59, 69, 89, 136` | Hardcoded LAN IP (`192.168.31.44`) Across Documentation |
| **D11** | Documentation | **LOW** | **CONFIRMED** | `vercel.json:1-17`, `.vercelignore:1-12`, `README.md` | Incompatible Deployment Claims (FastAPI/PyTorch on Vercel) |
| **D12** | Correctness | **HIGH** | **CONFIRMED** | `yolo26n.pt`, `config.py:32-106`, `detector.py:44-53` | Model Provenance & False Detection Capabilities (COCO vs Custom Waste) |
| **D13** | Correctness | **MEDIUM** | **CONFIRMED** | `detector.py:73`, `README.md:99`, EcoWing Schema | Inconsistent Confidence Units (0–1 vs 0–100 Percentage) |
| **D14** | Maintenance | **LOW** | **CONFIRMED** | `yolo26n.pt` | Binary Model Committed Without Git LFS or Source Provenance |
| **D15** | Maintenance | **LOW** | **CONFIRMED** | `package.json:1-12` | Superfluous Node.js `package.json` in Python FastAPI Project |
| **D16** | Quality | **LOW** | **CONFIRMED** | Workspace root, `app.py:30` | Directory Naming Typos and Title Inconsistencies |
| **D-NEW1** | Integration | **MEDIUM** | **NEW** | `public/static/js/main.js:120`, `public/mobile.html:409` | Hardcoded Third-Party Vercel Production Target (`eco-wing-7pua.vercel.app`) |

---

## Detailed Findings

### D1. Unauthenticated Control and Upload Endpoints
- **Repo & File:** `Detection`, `app.py:147-159` (`/api/settings`), `app.py:161-179` (`/api/upload`), `app.py:212-240` (`/ws/mobile_stream`), `app.py:122-145` (`/api/system_info`)
- **Severity:** **CRITICAL**
- **Status:** **CONFIRMED**
- **Evidence:**
  ```python
  @app.post("/api/settings")
  def update_settings(payload: SettingsRequest):
      if payload.confidence is not None:
          detector.set_confidence(payload.confidence)
      if payload.source is not None:
          stream_mgr.set_source(payload.source)
  ```
  Neither `/api/settings`, `/api/upload`, nor `/ws/mobile_stream` requires any authentication headers or tokens. Any unauthorized user on the network can switch video inputs (e.g. inject an attacker-controlled RTSP feed or video loop), alter detection sensitivity, upload files, or push frames to hijack the camera stream.

---

### D2. Control Panel Exposed on 0.0.0.0 & Public Internet Tunneling
- **Repo & File:** `Detection`, `config.py:10`, `app.py:261`, `start_tunnel.bat:9`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  `config.py` defaults to `DEFAULT_HOST = "0.0.0.0"`, causing Uvicorn to listen on all network interfaces. Furthermore, `start_tunnel.bat` runs `npx localtunnel --port 5000`, instantly exposing the unauthenticated control plane, camera feed, and settings modification endpoints to the public internet.

---

### D3. Insecure CORS Configuration
- **Repo & File:** `Detection`, `app.py:33-39`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  ```python
  app.add_middleware(
      CORSMiddleware,
      allow_origins=["*"],
      allow_credentials=True,
      allow_methods=["*"],
      allow_headers=["*"],
  )
  ```
  Combining `allow_origins=["*"]` with `allow_credentials=True` violates the CORS specification and exposes internal browser states. Browsers reject requests with credentials when wildcard origins are specified, and configuring wildcard credentials permits CSRF-like credential exfiltration.

---

### D4. RTSP Credentials Leaked via Plaintext String Serialization
- **Repo & File:** `Detection`, `app.py:122-145`, `app.py:147-159`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  `get_system_info()` returns `"current_source": str(stream_mgr.source)`. When an IP camera or drone stream is configured using standard RTSP URLs containing authentication (e.g., `rtsp://admin:Secr3tPass@192.168.1.55:554/h264`), the raw password is leaked in plaintext JSON over the network.

---

### D5. Detection Loop Tied to Video Viewers (Stale Telemetry Without Viewers)
- **Repo & File:** `Detection`, `app.py:71-120`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  In `app.py`, `detector.detect()` is only called inside the generator `generate_video_frames()`, which is exclusively driven by active client connections to `GET /video_feed`. If no browser or client is actively streaming MJPEG, `detector.detect()` is never executed. Consequently, `latest_summary` goes completely stale, and `/api/detections` and `/ws` return outdated or empty data.

---

### D6. Redundant Per-Viewer YOLO Inference Loop
- **Repo & File:** `Detection`, `app.py:71-112`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  Every time a client opens `/video_feed`, a new instance of `generate_video_frames()` is instantiated. Inside each generator loop:
  ```python
  annotated_frame, summary = detector.detect(frame, draw_overlay=draw_overlay, server_info=server_watermark)
  ```
  If 5 dashboard clients open the live stream, YOLO model inference (`detector.detect()`) is executed 5 times per frame on the same CPU/GPU, causing massive compute exhaustion, thermal throttling, and frame drops.

---

### D7. Unbounded Upload Sizes & WebSocket Client Limits
- **Repo & File:** `Detection`, `app.py:161-179, 181-201`
- **Severity:** **MEDIUM**
- **Status:** **CONFIRMED**
- **Evidence:**
  `/api/upload` uses `contents = await file.read()` with no length check or chunked validation, enabling denial-of-service via memory exhaustion (e.g. uploading a multi-gigabyte file). The `/ws` endpoint adds sockets to `active_websockets` with no connection concurrency limit or rate control.

---

### D8. Mixed Content Blocking on HTTPS Embedding
- **Repo & File:** `Detection`, `app.py:125-144`, `README.md:58-80`
- **Severity:** **MEDIUM**
- **Status:** **CONFIRMED**
- **Evidence:**
  `app.py` generates integration snippets hardcoded to `http://{LOCAL_IP}:{DEFAULT_PORT}/video_feed`. When the EcoWing dashboard is accessed over HTTPS (as in standard production/cloud deployments), modern browsers block all plain HTTP image, media, and API requests under strict Mixed Content security policies.

---

### D9. Browser Camera Access (`getUserMedia`) Blocked Over Plain HTTP
- **Repo & File:** `Detection`, `public/mobile.html:477`, `templates/mobile.html:477`
- **Severity:** **MEDIUM**
- **Status:** **CONFIRMED**
- **Evidence:**
  Web standards require a Secure Context (HTTPS or `localhost`) for `navigator.mediaDevices.getUserMedia()`. When users navigate to `http://<LAN-IP>:5000/mobile` from their mobile phone, mobile browsers (Chrome, Safari, iOS WebKit) strictly disable camera access with a permission denied error.

---

### D10. Hardcoded LAN IP in Documentation and Code
- **Repo & File:** `Detection`, `README.md:41-47, 59, 69, 89, 136`
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  `README.md` repeatedly instructs users to connect to `http://192.168.31.44:5000/video_feed`. This IP is specific to one particular developer's local network and breaks whenever DHCP assigns a new lease or the server runs on a different subnet.

---

### D11. Incompatible Deployment Claims (FastAPI on Vercel)
- **Repo & File:** `Detection`, `vercel.json:1-17`, `.vercelignore:1-12`, `README.md`
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  `vercel.json` and `.vercelignore` strip all Python requirements (`requirements.txt`, PyTorch, OpenCV, `run.py`, `yolo26n.pt`) to avoid Vercel's 250MB serverless lambda size limit. Vercel cannot run hardware video streaming or continuous YOLO inference. The repository should clarify that the Python service must run on a host machine with camera access.

---

### D12. Model Provenance & False Detection Capabilities
- **Repo & File:** `Detection`, `yolo26n.pt`, `config.py:32-106`, `detector.py:44-53`
- **Severity:** **HIGH**
- **Status:** **CONFIRMED**
- **Evidence:**
  Inspection of `yolo26n.pt` confirmed it is a standard 80-class COCO pretrained model (`person`, `bicycle`, `bottle`, `cup`, `banana`, `apple`, etc.). It contains **zero** trained classes for `paper`, `cardboard`, `plastic`, or `can`.
  The README claims it detects "Paper, Glass, Can / Metal, Cardboard, Plastic". In reality, `config.py` maps COCO classes (`bottle` $\rightarrow$ plastic/glass, `book` $\rightarrow$ paper, `cup` $\rightarrow$ can, `sandwich`/`banana` $\rightarrow$ organic). Any actual waste paper or cardboard that does not resemble a `book` or `bottle` is ignored.

---

### D13. Inconsistent Confidence Units (0–1 vs 0–100)
- **Repo & File:** `Detection`, `detector.py:73`, `README.md:99`, `EcoWing/backend/models/Detection.js:52`
- **Severity:** **MEDIUM**
- **Status:** **CONFIRMED**
- **Evidence:**
  In `detector.py`, confidence is formatted as percentage: `"confidence": round(conf * 100, 1)`. In `README.md`, the documentation example formats it with an additional `%`: `${item.confidence}%`. Meanwhile, EcoWing's MongoDB model schema enforces `min: 0, max: 1`. Sending `85.5` directly causes validation failure in MongoDB.

---

### D14. Binary Weights Committed Without Git LFS
- **Repo & File:** `Detection`, `yolo26n.pt` (5.5 MB)
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  `yolo26n.pt` is committed directly into the git tree without Git LFS pointers or provenance metadata (hash, training run details, base architecture).

---

### D15. Superfluous Node.js `package.json`
- **Repo & File:** `Detection`, `package.json:1-12`
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  The Python service does not utilize npm packages or Node dependencies for backend execution. `package.json` was introduced as a workaround for Vercel static build detection.

---

### D16. Workspace and Directory Naming Inconsistencies
- **Repo & File:** Directory `detction system`, `app.py:30`
- **Severity:** **LOW**
- **Status:** **CONFIRMED**
- **Evidence:**
  The local project folder is misspelled as `detction system`, while documentation refers to `Detection` and `EcoWing AI Waste Detection`.

---

### D-NEW1. Hardcoded Third-Party Vercel Production Target
- **Repo & File:** `Detection`, `public/static/js/main.js:120`, `public/mobile.html:409`
- **Severity:** **MEDIUM**
- **Status:** **NEW**
- **Evidence:**
  `main.js` and `mobile.html` contain fallback target URLs pointing to `https://eco-wing-7pua.vercel.app`. This creates unexpected external network dependencies when testing in private LAN or airgapped environments.

