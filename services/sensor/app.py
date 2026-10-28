import sys

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

import cv2
import time
import json
import asyncio
import base64
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import (
    DEFAULT_HOST, DEFAULT_PORT, DEFAULT_CONFIDENCE,
    get_local_ip, MODEL_PATH, WASTE_TAXONOMY
)
from detector import WasteDetector
from video_stream import VideoStreamManager

app = FastAPI(title="EcoWing Waste Detection & Streaming System", version="1.0.0")

# Enable CORS for EcoWing Website integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
detector = WasteDetector(confidence=DEFAULT_CONFIDENCE)
stream_mgr = VideoStreamManager(source=0)
latest_summary = {
    "total_count": 0,
    "recyclable_count": 0,
    "non_recyclable_count": 0,
    "biodegradable_count": 0,
    "non_biodegradable_count": 0,
    "items": [],
    "timestamp": time.time()
}
active_websockets = set()
LOCAL_IP = get_local_ip()

class SettingsRequest(BaseModel):
    confidence: Optional[float] = None
    source: Optional[str] = None

def generate_video_frames(draw_overlay: bool = True):
    """Generator function that yields JPEG frames for MJPEG streaming."""
    global latest_summary
    server_watermark = f"{LOCAL_IP}:{DEFAULT_PORT}"
    
    while True:
        frame = stream_mgr.get_frame()
        if frame is None or frame.size == 0:
            time.sleep(0.04)
            continue
            
        annotated_frame, summary = detector.detect(
            frame, 
            draw_overlay=draw_overlay,
            server_info=server_watermark
        )
        latest_summary = summary
        
        # Encode frame to JPEG
        ret, buffer = cv2.imencode('.jpg', annotated_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ret:
            time.sleep(0.02)
            continue
            
        frame_bytes = buffer.tobytes()
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        
        # Regulate framerate (~25-30 FPS)
        time.sleep(0.033)

@app.get("/video_feed")
def video_feed(overlay: bool = True):
    """
    Primary video stream endpoint.
    Embed in EcoWing website with:
    <img src="http://<IP>:<PORT>/video_feed" />
    """
    return StreamingResponse(
        generate_video_frames(draw_overlay=overlay),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.get("/api/detections")
def get_detections():
    """Returns the latest real-time waste classification and counts as JSON."""
    return JSONResponse(content={
        "status": "success",
        "data": latest_summary
    })

@app.get("/api/system_info")
def get_system_info():
    """Provides IP addresses, stream endpoints, and integration code snippets."""
    stream_url = f"http://{LOCAL_IP}:{DEFAULT_PORT}/video_feed"
    api_url = f"http://{LOCAL_IP}:{DEFAULT_PORT}/api/detections"
    mobile_url = f"http://{LOCAL_IP}:{DEFAULT_PORT}/mobile"
    
    return {
        "status": "online",
        "local_ip": LOCAL_IP,
        "port": DEFAULT_PORT,
        "video_stream_url": stream_url,
        "api_detections_url": api_url,
        "mobile_stream_url": mobile_url,
        "is_simulator": stream_mgr.is_simulator,
        "current_source": str(stream_mgr.source),
        "confidence_threshold": detector.confidence,
        "model_file": MODEL_PATH.name,
        "integration_examples": {
            "html": f'<img src="{stream_url}" alt="EcoWing Waste Detection Stream" style="width: 100%; border-radius: 12px;" />',
            "react": f'<img src="{stream_url}" alt="EcoWing Stream" className="w-full rounded-xl shadow-md" />',
            "fetch_js": f'fetch("{api_url}").then(r => r.json()).then(data => console.log(data));'
        }
    }

@app.post("/api/settings")
def update_settings(payload: SettingsRequest):
    """Dynamically adjusts confidence threshold or video source."""
    if payload.confidence is not None:
        detector.set_confidence(payload.confidence)
    if payload.source is not None:
        stream_mgr.set_source(payload.source)
    return {
        "status": "updated",
        "confidence": detector.confidence,
        "source": str(stream_mgr.source),
        "is_simulator": stream_mgr.is_simulator
    }

@app.post("/api/upload")
async def upload_waste_image(file: UploadFile = File(...)):
    """Accepts an uploaded image file and returns waste analysis and annotated image."""
    contents = await file.read()
    nparr = cv2.imdecode(cv2.frombuffer(contents, dtype=cv2.IMREAD_COLOR), cv2.IMREAD_COLOR)
    if nparr is None:
        return JSONResponse(status_code=400, content={"error": "Invalid image file format."})
        
    annotated, summary = detector.detect(nparr, draw_overlay=True, server_info="ECOWING UPLOAD")
    
    # Encode annotated image to Base64
    _, buf = cv2.imencode('.jpg', annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    img_b64 = base64.b64encode(buf).decode('utf-8')
    
    return {
        "status": "success",
        "analysis": summary,
        "annotated_image": f"data:image/jpeg;base64,{img_b64}"
    }

@app.websocket("/ws")
async def websocket_telemetry(websocket: WebSocket):
    """Pushes real-time detection telemetry at regular intervals to web clients."""
    await websocket.accept()
    active_websockets.add(websocket)
    try:
        while True:
            payload = {
                "type": "telemetry",
                "summary": latest_summary,
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
    mobile_file = TEMPLATES_DIR / "mobile.html"
    if not mobile_file.exists():
        mobile_file = BASE_DIR / "templates" / "mobile.html"
    if mobile_file.exists():
        return mobile_file.read_text(encoding="utf-8")
    return "<h1>EcoWing Mobile Stream</h1>"

@app.websocket("/ws/mobile_stream")
async def websocket_mobile_stream(websocket: WebSocket):
    """
    Receives live camera frames from a mobile phone browser,
    feeds them into the YOLO detector, and returns real-time waste feedback.
    """
    import numpy as np
    await websocket.accept()
    print("[MobileStream] Mobile phone connected to camera stream!")
    try:
        while True:
            # Receive binary JPEG frame from phone
            data = await websocket.receive_bytes()
            if data:
                nparr = np.frombuffer(data, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is not None:
                    stream_mgr.update_mobile_frame(frame)
                    
            # Send latest detection feedback back to phone HUD
            await websocket.send_text(json.dumps({
                "type": "detection_feedback",
                "data": latest_summary
            }))
    except WebSocketDisconnect:
        print("[MobileStream] Mobile phone disconnected.")
    except Exception as e:
        print(f"[MobileStream] Connection error: {e}")

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

