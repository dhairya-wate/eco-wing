import sys

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

import cv2
import time
import datetime
import json
import struct
import asyncio
import base64
import secrets
import logging
import ipaddress
from pathlib import Path
import hmac
from typing import Optional

logger = logging.getLogger("ecowing.detection")

# Fixed close reason strings (strictly <= 123 bytes per RFC 6455 Section 5.5)
CLOSE_REASONS = {
    "DISABLED": "Policy violation: Mobile streaming disabled",
    "CAPPED": "Try again later: Mobile connection limit reached",
    "TIMEOUT": "Policy violation: Authentication handshake timed out",
    "BINARY_FRAME": "Policy violation: Binary frame sent before authentication",
    "MISSING_TEXT": "Policy violation: Missing text payload in authentication handshake",
    "INVALID_JSON": "Policy violation: Invalid JSON in authentication payload",
    "WRONG_TYPE": "Policy violation: First message type must be 'auth'",
    "MISSING_SESSION": "Policy violation: Missing or invalid 'session' field",
    "EXPIRED_SESSION": "Policy violation: Invalid or expired mobile session",
    "MSG_TOO_BIG": "Policy violation: Message exceeds 5MB limit",
    "SERVER_ERROR": "Internal server error: Frame ingestion failed"
}

from contextlib import asynccontextmanager
from fastapi import (
    FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect,
    Header, HTTPException, status, Depends, Request
)
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import numpy as np

from worker import DetectionWorker
from config import (
    DEFAULT_HOST, DEFAULT_PORT, DEFAULT_CONFIDENCE, DEFAULT_SOURCE,
    DETECTION_STALE_AFTER_SECONDS,
    get_local_ip, MODEL_PATH, WASTE_TAXONOMY,
    OPERATOR_TOKEN, CORS_ORIGINS, MAX_UPLOAD_SIZE_BYTES,
    MAX_WS_CONNECTIONS, MAX_MOBILE_WS_CONNECTIONS, sanitize_source_url,
    MOBILE_ENABLED, PAIRING_CODE_EXPIRY_SECONDS, MOBILE_SESSION_EXPIRY_SECONDS,
    TRUSTED_PROXIES
)
from detector import WasteDetector
from video_stream import VideoStreamManager

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager: starts background detection worker on startup and terminates on exit."""
    worker.start()
    yield
    worker.stop()

app = FastAPI(
    title="EcoWing Waste Detection & Streaming System",
    version="1.0.0",
    lifespan=lifespan
)

# Security: Explicit CORS allowlist without insecure wildcard credentials
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

def verify_operator_token(
    x_operator_token: Optional[str] = Header(None, alias="X-Operator-Token"),
):
    """
    Validates operator authentication token in constant time.
    Accepts token strictly via 'X-Operator-Token' HTTP header.
    Query-parameter token authentication is strictly prohibited and rejected.
    """
    if not x_operator_token or not hmac.compare_digest(str(x_operator_token).strip(), OPERATOR_TOKEN):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: invalid or missing operator token. Provide 'X-Operator-Token' header.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return x_operator_token

# Paths
BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = (BASE_DIR / "public").exists() and (BASE_DIR / "public") or (BASE_DIR / "templates")
STATIC_DIR = (BASE_DIR / "public" / "static").exists() and (BASE_DIR / "public" / "static") or (BASE_DIR / "static")
STATIC_DIR.mkdir(parents=True, exist_ok=True)
(STATIC_DIR / "css").mkdir(parents=True, exist_ok=True)
(STATIC_DIR / "js").mkdir(parents=True, exist_ok=True)
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Shared state
LOCAL_IP = get_local_ip()
detector = WasteDetector(confidence=DEFAULT_CONFIDENCE)
stream_mgr = VideoStreamManager(source=DEFAULT_SOURCE)
worker = DetectionWorker(
    detector=detector,
    stream_mgr=stream_mgr,
    watermark=f"{LOCAL_IP}:{DEFAULT_PORT}"
)
active_websockets = set()
active_mobile_websockets = set()
pending_mobile_websockets = set()

# Mobile Camera Pairing State (In-Memory Only)
UNAMBIGUOUS_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
MAX_FAILED_IP_ATTEMPTS = 5

# code -> {"created_at": float, "expires_at": float}
active_pairing_codes = {}
# session_token -> {"created_at": float, "expires_at": float}
active_mobile_sessions = {}
# ip -> list of timestamps
ip_exchange_rate_limits = {}
# ip -> {"failed": int, "locked_until": float}
ip_failed_exchange_attempts = {}

def parse_image_dimensions(data: bytes) -> tuple[int, int]:
    """
    Parses image dimensions (width, height) directly from the raw byte header
    without decoding pixel rasters or using heavy decoding routines.
    Supports PNG, JPEG, GIF, BMP, and WebP (VP8, VP8L, VP8X).
    Raises ValueError if format is unrecognized or header is corrupt/truncated.
    """
    if len(data) < 16:
        raise ValueError("Payload too small to contain a valid image header.")

    # 1. WebP: 'RIFF' .... 'WEBP'
    if data.startswith(b"RIFF") and len(data) >= 16 and data[8:12] == b"WEBP":
        chunk_type = data[12:16]
        # Extended WebP VP8X: 24-bit canvas width at bytes 24-26, height at bytes 27-29
        if chunk_type == b"VP8X":
            if len(data) < 30:
                raise ValueError("Incomplete WebP VP8X header.")
            w = 1 + (data[24] | (data[25] << 8) | (data[26] << 16))
            h = 1 + (data[27] | (data[28] << 8) | (data[29] << 16))
            return w, h
        # Lossless WebP VP8L: signature 0x2F followed by 14-bit width + 14-bit height
        elif chunk_type == b"VP8L":
            if len(data) < 25 or data[20] != 0x2F:
                raise ValueError("Incomplete or invalid WebP VP8L header.")
            b = struct.unpack("<I", data[21:25])[0]
            w = 1 + (b & 0x3FFF)
            h = 1 + ((b >> 14) & 0x3FFF)
            return w, h
        # Simple Lossy WebP VP8: start code \x9d\x01\x2a followed by 16-bit LE dims
        elif chunk_type == b"VP8 ":
            if len(data) < 30:
                raise ValueError("Incomplete WebP VP8 header.")
            w = struct.unpack("<H", data[26:28])[0] & 0x3FFF
            h = struct.unpack("<H", data[28:30])[0] & 0x3FFF
            return w, h
        raise ValueError(f"Unsupported WebP chunk type: {chunk_type}")

    # 2. PNG: Header (8 bytes) + IHDR chunk (length 4, 'IHDR' 4, width 4 BE, height 4 BE)
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(data) < 24:
            raise ValueError("Incomplete PNG header.")
        w, h = struct.unpack(">II", data[16:24])
        return w, h

    # 3. GIF: 'GIF87a' or 'GIF89a' followed by width (2 bytes LE) and height (2 bytes LE)
    if data.startswith((b"GIF87a", b"GIF89a")):
        if len(data) < 10:
            raise ValueError("Incomplete GIF header.")
        w, h = struct.unpack("<HH", data[6:10])
        return w, h

    # 4. BMP: 'BM' followed by DIB header where width is at 18..22 and height at 22..26
    if data.startswith(b"BM"):
        if len(data) < 26:
            raise ValueError("Incomplete BMP header.")
        w, h = struct.unpack("<ii", data[18:26])
        return abs(w), abs(h)

    # 5. JPEG: 0xFF, 0xD8 start of image marker
    if data.startswith(b"\xff\xd8"):
        idx = 2
        data_len = len(data)
        while idx < data_len - 1:
            if data[idx] != 0xFF:
                idx += 1
                continue
            marker = data[idx + 1]
            idx += 2
            # SOF markers: SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                if idx + 7 > data_len:
                    raise ValueError("Truncated JPEG SOF segment.")
                h, w = struct.unpack(">HH", data[idx + 3 : idx + 7])
                return w, h
            elif marker in (0xD8, 0xD9):
                continue
            elif marker == 0xDA:
                break
            else:
                if idx + 2 > data_len:
                    break
                seg_len = struct.unpack(">H", data[idx : idx + 2])[0]
                idx += seg_len
        raise ValueError("Could not find JPEG SOF marker to read dimensions.")

    raise ValueError("Unsupported or unrecognized image header format.")

def is_trusted_proxy(ip_str: str) -> bool:
    """Checks whether the direct peer socket IP matches an exact configured trusted gateway IP (no subnet matching)."""
    if not ip_str:
        return False
    clean_ip = ip_str.strip().lower()
    return clean_ip in TRUSTED_PROXIES

def get_client_ip(request: Request) -> str:
    """
    Extracts the verified client IP address.
    Uses X-Forwarded-For ONLY when the direct peer socket IP matches an exact configured TRUSTED_PROXIES gateway IP.
    Otherwise, returns the raw peer socket IP to prevent header spoofing.
    """
    socket_ip = request.client.host if request.client else "127.0.0.1"
    if is_trusted_proxy(socket_ip):
        xff = request.headers.get("x-forwarded-for")
        if xff:
            client_ip = xff.split(",")[0].strip()
            if client_ip:
                return client_ip
    return socket_ip

def prune_stale_records(now: Optional[float] = None) -> None:
    """
    Prunes expired pairing codes, expired mobile sessions,
    and stale IP rate-limiting records to guarantee dictionary memory bounds.
    """
    if now is None:
        now = time.time()

    # 1. Prune expired pairing codes
    for c, data in list(active_pairing_codes.items()):
        if data.get("expires_at", 0) <= now:
            active_pairing_codes.pop(c, None)

    # 2. Prune expired mobile sessions
    for s, data in list(active_mobile_sessions.items()):
        if data.get("expires_at", 0) <= now:
            active_mobile_sessions.pop(s, None)

    # 3. Prune stale IP rate limits (older than 60s)
    for ip, timestamps in list(ip_exchange_rate_limits.items()):
        valid_ts = [t for t in timestamps if now - t < 60.0]
        if valid_ts:
            ip_exchange_rate_limits[ip] = valid_ts
        else:
            ip_exchange_rate_limits.pop(ip, None)

    # 4. Prune expired IP lockouts
    for ip, data in list(ip_failed_exchange_attempts.items()):
        if data.get("locked_until", 0) <= now and data.get("failed", 0) == 0:
            ip_failed_exchange_attempts.pop(ip, None)

class SettingsRequest(BaseModel):
    confidence: Optional[float] = None
    source: Optional[str] = None

class CodeExchangeRequest(BaseModel):
    code: str

@app.get("/video_feed")
async def video_feed(request: Request, overlay: bool = True):
    """
    Primary public video stream endpoint.
    Reads latest pre-rendered frame from background detection worker without per-viewer detection overhead.
    """
    async def frame_stream():
        try:
            while True:
                jpeg_bytes = worker.get_latest_jpeg()
                if jpeg_bytes is None:
                    await asyncio.sleep(0.03)
                    continue
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + jpeg_bytes + b'\r\n')
                await asyncio.sleep(0.033)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        frame_stream(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.get("/api/detections")
def get_detections():
    """Returns the latest real-time waste classification, counts, and staleness metadata as public JSON."""
    summary, last_update = worker.get_latest_summary_and_update_time()
    now = time.time()
    age = max(0.0, round(now - last_update, 3))
    stale = age > DETECTION_STALE_AFTER_SECONDS
    return JSONResponse(content={
        "status": "success",
        "timestamp": last_update,
        "timestamp_iso": datetime.datetime.fromtimestamp(last_update, tz=datetime.timezone.utc).isoformat(),
        "age_seconds": age,
        "stale": stale,
        "data": summary
    })

@app.get("/api/system_info", dependencies=[Depends(verify_operator_token)])
def get_system_info():
    """Provides IP addresses, stream endpoints, and integration code snippets (Operator Protected)."""
    stream_url = f"http://{LOCAL_IP}:{DEFAULT_PORT}/video_feed"
    api_url = f"http://{LOCAL_IP}:{DEFAULT_PORT}/api/detections"
    mobile_url = f"http://{LOCAL_IP}:{DEFAULT_PORT}/mobile"
    
    return {
        "status": "online",
        "worker_running": worker.is_worker_alive,
        "local_ip": LOCAL_IP,
        "port": DEFAULT_PORT,
        "video_stream_url": stream_url,
        "api_detections_url": api_url,
        "mobile_stream_url": mobile_url,
        "is_simulator": stream_mgr.is_simulator,
        "current_source": sanitize_source_url(stream_mgr.source),
        "confidence_threshold": detector.confidence,
        "model_file": MODEL_PATH.name,
        "integration_examples": {
            "html": f'<img src="{stream_url}" alt="EcoWing Waste Detection Stream" style="width: 100%; border-radius: 12px;" />',
            "react": f'<img src="{stream_url}" alt="EcoWing Stream" className="w-full rounded-xl shadow-md" />',
            "fetch_js": f'fetch("{api_url}").then(r => r.json()).then(data => console.log(data));'
        }
    }

@app.post("/api/settings", dependencies=[Depends(verify_operator_token)])
def update_settings(payload: SettingsRequest):
    """Dynamically adjusts confidence threshold or video source (Operator Protected)."""
    if payload.confidence is not None:
        if payload.confidence < 0.0 or payload.confidence > 1.0:
            raise HTTPException(
                status_code=400,
                detail="Confidence threshold must be a float between 0.0 and 1.0 (got percentage or out-of-range value)."
            )
        detector.set_confidence(payload.confidence)
    if payload.source is not None:
        stream_mgr.set_source(payload.source)
    return {
        "status": "updated",
        "confidence": detector.confidence,
        "source": sanitize_source_url(stream_mgr.source),
        "is_simulator": stream_mgr.is_simulator
    }

@app.post("/api/upload", dependencies=[Depends(verify_operator_token)])
async def upload_waste_image(request: Request, file: UploadFile = File(...)):
    """
    Accepts an uploaded image file, validates declared size and header dimensions
    strictly before decoding pixels, and returns analysis (Operator Protected).
    """
    # 1. Validate declared Content-Length header
    cl_header = request.headers.get("content-length")
    if cl_header:
        try:
            declared_cl = int(cl_header)
            if declared_cl > MAX_UPLOAD_SIZE_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"Upload size ({declared_cl} bytes) exceeds maximum allowed limit of {MAX_UPLOAD_SIZE_BYTES // (1024 * 1024)} MB."
                )
        except (ValueError, TypeError):
            pass

    # 2. Validate declared file size if populated by ASGI
    file_size = getattr(file, "size", None)
    if file_size is not None and file_size > MAX_UPLOAD_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Upload size ({file_size} bytes) exceeds maximum allowed limit of {MAX_UPLOAD_SIZE_BYTES // (1024 * 1024)} MB."
        )

    # 3. Read body in chunks with maximum size enforcement
    contents = bytearray()
    chunk_size = 1024 * 64
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        contents.extend(chunk)
        if len(contents) > MAX_UPLOAD_SIZE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Upload size exceeds maximum allowed limit of {MAX_UPLOAD_SIZE_BYTES // (1024 * 1024)} MB."
            )

    # 4. Extract dimensions from header BEFORE calling imdecode
    try:
        w, h = parse_image_dimensions(bytes(contents))
    except ValueError as parse_err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid image format or header: {parse_err}"
        )

    # 5. Enforce dimension boundaries (16x16 to 4096x4096) before decode
    if h < 16 or w < 16 or h > 4096 or w > 4096:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Image dimensions ({w}x{h}) outside allowed limits (16x16 to 4096x4096)."
        )

    # 6. Dimensions verified; safe to decode raster pixels
    nparr = cv2.imdecode(np.frombuffer(contents, dtype=np.uint8), cv2.IMREAD_COLOR)
    if nparr is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Corrupted image raster data: failed to decode."
        )

    annotated, summary = detector.detect(nparr, draw_overlay=True, server_info="ECOWING UPLOAD")

    # Encode annotated image to Base64
    _, buf = cv2.imencode('.jpg', annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    img_b64 = base64.b64encode(buf).decode('utf-8')

    return {
        "status": "success",
        "analysis": summary,
        "annotated_image": f"data:image/jpeg;base64,{img_b64}"
    }

@app.post("/api/mobile/pairing_code", dependencies=[Depends(verify_operator_token)])
def create_pairing_code():
    """Generates a short-lived 8-character pairing code from unambiguous alphabet for mobile onboarding (Operator Protected)."""
    if not MOBILE_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Mobile camera streaming feature is disabled by configuration (MOBILE_ENABLED=false)."
        )
    now = time.time()
    prune_stale_records(now)

    # 8 characters using secrets.choice from unambiguous alphabet
    code = "".join(secrets.choice(UNAMBIGUOUS_ALPHABET) for _ in range(8))
    active_pairing_codes[code] = {
        "created_at": now,
        "expires_at": now + PAIRING_CODE_EXPIRY_SECONDS
    }
    return {
        "status": "success",
        "pairing_code": code,
        "expires_in": PAIRING_CODE_EXPIRY_SECONDS
    }

@app.post("/api/mobile/exchange")
def exchange_pairing_code(payload: CodeExchangeRequest, request: Request):
    """
    Exchanges a one-time pairing code for a scoped mobile stream session token (Public).
    Enforces per-IP failure lockouts (5 failed attempts locks IP for 10 minutes)
    and IP rate-limiting with trusted proxy support.
    """
    if not MOBILE_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Mobile camera streaming feature is disabled by configuration (MOBILE_ENABLED=false)."
        )
    now = time.time()
    prune_stale_records(now)

    client_ip = get_client_ip(request)

    # 1. Per-IP Lockout Check
    ip_data = ip_failed_exchange_attempts.setdefault(client_ip, {"failed": 0, "locked_until": 0.0})
    if ip_data["locked_until"] > 0:
        if ip_data["locked_until"] > now:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"IP temporarily locked out due to excessive failed exchange attempts. Try again in {int(ip_data['locked_until'] - now)}s."
            )
        else:
            # Lockout expired: reset failed to 0 and clear locked_until
            ip_data["failed"] = 0
            ip_data["locked_until"] = 0.0

    # 2. Per-IP Sliding-Window Rate Limit (10 req/min)
    timestamps = ip_exchange_rate_limits.setdefault(client_ip, [])
    ip_exchange_rate_limits[client_ip] = [t for t in timestamps if now - t < 60.0]
    if len(ip_exchange_rate_limits[client_ip]) >= 10:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many pairing exchange requests. Please slow down."
        )
    ip_exchange_rate_limits[client_ip].append(now)

    code = (payload.code or "").strip().upper()
    code_data = active_pairing_codes.get(code)

    # Validate code existence and expiration
    if not code_data or code_data["expires_at"] <= now:
        ip_data["failed"] += 1
        if ip_data["failed"] >= MAX_FAILED_IP_ATTEMPTS:
            # Explicit code path setting locked_until on 5th failed exchange attempt
            ip_data["locked_until"] = now + 600.0  # 10 minute lockout
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many failed pairing attempts. IP address locked out for 10 minutes."
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired pairing code."
        )

    # Single-use: burn pairing code immediately upon successful exchange
    active_pairing_codes.pop(code, None)
    ip_data["failed"] = 0  # reset IP failures on success
    ip_data["locked_until"] = 0.0

    session_token = secrets.token_urlsafe(32)
    active_mobile_sessions[session_token] = {
        "created_at": now,
        "expires_at": now + MOBILE_SESSION_EXPIRY_SECONDS
    }
    return {
        "status": "success",
        "session_token": session_token,
        "expires_in": MOBILE_SESSION_EXPIRY_SECONDS
    }

@app.websocket("/ws")
async def websocket_telemetry(websocket: WebSocket):
    """Pushes real-time detection telemetry at regular intervals to web clients with concurrency caps (Public)."""
    if len(active_websockets) >= MAX_WS_CONNECTIONS:
        await websocket.close(code=1013, reason="Try again later: Telemetry connection limit reached")
        return

    await websocket.accept()
    active_websockets.add(websocket)
    try:
        while True:
            payload = {
                "type": "telemetry",
                "summary": worker.get_latest_summary(),
                "server_time": time.time()
            }
            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(0.2) # 5 Hz update
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        active_websockets.discard(websocket)

@app.get("/mobile", response_class=HTMLResponse)
def mobile_page():
    """Serves the mobile phone camera streaming interface."""
    if not MOBILE_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Mobile camera streaming feature is disabled by configuration (MOBILE_ENABLED=false)."
        )
    mobile_file = TEMPLATES_DIR / "mobile.html"
    if not mobile_file.exists():
        mobile_file = BASE_DIR / "templates" / "mobile.html"
    if mobile_file.exists():
        return mobile_file.read_text(encoding="utf-8")
    return "<h1>EcoWing Mobile Stream</h1>"

@app.websocket("/ws/mobile_stream")
async def websocket_mobile_stream(websocket: WebSocket):
    """
    Receives live camera frames from a paired mobile phone browser.
    In-band authentication: client sends {'type':'auth','session':'...'} as first message.
    Session is consumed immediately on connect to prevent socket replay attacks.
    Connection caps count both pending and active sockets against MAX_MOBILE_WS_CONNECTIONS.
    """
    if not MOBILE_ENABLED:
        await websocket.accept()
        await websocket.close(code=1008, reason=CLOSE_REASONS["DISABLED"])
        return

    # Check connection cap: count both pending and active sockets
    if len(active_mobile_websockets) + len(pending_mobile_websockets) >= MAX_MOBILE_WS_CONNECTIONS:
        await websocket.accept()
        await websocket.close(code=1013, reason=CLOSE_REASONS["CAPPED"])
        return

    # SYNCHRONOUSLY ADD TO PENDING SET RIGHT HERE BEFORE ANY AWAIT!
    pending_mobile_websockets.add(websocket)

    try:
        await websocket.accept()
    except Exception:
        pending_mobile_websockets.discard(websocket)
        return

    try:
        # In-band authentication handshake with comprehensive error handling
        try:
            raw_msg = await asyncio.wait_for(websocket.receive(), timeout=5.0)
        except asyncio.TimeoutError:
            pending_mobile_websockets.discard(websocket)
            await websocket.close(code=1008, reason=CLOSE_REASONS["TIMEOUT"])
            return
        except Exception as e:
            logger.error("Handshake receive error: %s", e)
            pending_mobile_websockets.discard(websocket)
            await websocket.close(code=1008, reason=CLOSE_REASONS["TIMEOUT"])
            return

        # Check for disconnect frame
        if raw_msg.get("type") == "websocket.disconnect":
            pending_mobile_websockets.discard(websocket)
            return

        # Reject binary frame sent before authentication
        if "bytes" in raw_msg and raw_msg["bytes"] is not None:
            pending_mobile_websockets.discard(websocket)
            await websocket.close(code=1008, reason=CLOSE_REASONS["BINARY_FRAME"])
            return

        # Extract text payload
        text_data = raw_msg.get("text")
        if text_data is None:
            pending_mobile_websockets.discard(websocket)
            await websocket.close(code=1008, reason=CLOSE_REASONS["MISSING_TEXT"])
            return

        # Parse JSON
        try:
            auth_msg = json.loads(text_data)
        except (json.JSONDecodeError, TypeError):
            pending_mobile_websockets.discard(websocket)
            await websocket.close(code=1008, reason=CLOSE_REASONS["INVALID_JSON"])
            return

        # Verify message structure and type
        if not isinstance(auth_msg, dict) or auth_msg.get("type") != "auth":
            pending_mobile_websockets.discard(websocket)
            await websocket.close(code=1008, reason=CLOSE_REASONS["WRONG_TYPE"])
            return

        # Verify presence of session field
        session_val = auth_msg.get("session")
        if not session_val or not isinstance(session_val, str) or not session_val.strip():
            pending_mobile_websockets.discard(websocket)
            await websocket.close(code=1008, reason=CLOSE_REASONS["MISSING_SESSION"])
            return

        session = session_val.strip()
        now = time.time()
        prune_stale_records(now)

        session_data = active_mobile_sessions.get(session)
        if not session_data or session_data["expires_at"] <= now:
            if session in active_mobile_sessions:
                active_mobile_sessions.pop(session, None)
            pending_mobile_websockets.discard(websocket)
            await websocket.close(code=1008, reason=CLOSE_REASONS["EXPIRED_SESSION"])
            return

        # CONSUME ON CONNECT: Prevent replay by a second socket
        active_mobile_sessions.pop(session, None)

        # Transition socket from pending to active
        pending_mobile_websockets.discard(websocket)
        active_mobile_websockets.add(websocket)

        await websocket.send_text(json.dumps({"type": "auth_ok"}))
        while True:
            data = await websocket.receive_bytes()
            if data:
                if len(data) > MAX_UPLOAD_SIZE_BYTES:
                    # Enforce 5MB limit at application layer across all ASGI launch paths
                    await websocket.close(code=1009, reason=CLOSE_REASONS["MSG_TOO_BIG"])
                    return
                nparr = np.frombuffer(data, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is not None:
                    stream_mgr.update_mobile_frame(frame)

            await websocket.send_text(json.dumps({
                "type": "detection_feedback",
                "data": worker.get_latest_summary()
            }))
    except WebSocketDisconnect:
        logger.info("Mobile stream client disconnected cleanly")
    except Exception as err:
        logger.error("Error in mobile frame ingestion loop: %s", err, exc_info=True)
        try:
            await websocket.close(code=1011, reason=CLOSE_REASONS["SERVER_ERROR"])
        except Exception:
            pass
    finally:
        active_mobile_websockets.discard(websocket)
        pending_mobile_websockets.discard(websocket)

@app.get("/", response_class=HTMLResponse)
def index_page():
    """Serves the EcoWing detection interface and website integration portal."""
    template_file = TEMPLATES_DIR / "index.html"
    if not template_file.exists():
        template_file = BASE_DIR / "templates" / "index.html"
    if template_file.exists():
        return template_file.read_text(encoding="utf-8")
    return "<h1>EcoWing Waste Detection System is Running!</h1>"

if __name__ == "__main__":
    import uvicorn
    print("\n" + "=" * 65)
    print("  [ECOWING] AI WASTE DETECTION & STREAMING SERVER")
    print("=" * 65)
    print(f"  • Local Dashboard:        http://localhost:{DEFAULT_PORT}")
    print(f"  • Network Dashboard:      http://{LOCAL_IP}:{DEFAULT_PORT}")
    print(f"  • Website Stream Link:    http://{LOCAL_IP}:{DEFAULT_PORT}/video_feed")
    print(f"  • Website JSON API:       http://{LOCAL_IP}:{DEFAULT_PORT}/api/detections")
    print("=" * 65 + "\n")
    uvicorn.run(app, host=DEFAULT_HOST, port=DEFAULT_PORT, log_level="info")
