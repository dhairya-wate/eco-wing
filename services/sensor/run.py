import sys
from pathlib import Path

# Ensure UTF-8 output on Windows consoles
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Ensure ecowing_sensor package in src is on sys.path
sensor_pkg_dir = Path(__file__).resolve().parent / "src" / "ecowing_sensor"
if sensor_pkg_dir.exists() and str(sensor_pkg_dir) not in sys.path:
    sys.path.insert(0, str(sensor_pkg_dir))

# Also load .env from current directory if present
env_file = Path(__file__).resolve().parent / ".env"
if env_file.exists():
    try:
        from dotenv import load_dotenv
        load_dotenv(env_file)
    except ImportError:
        pass

import uvicorn
from config import DEFAULT_HOST, DEFAULT_PORT, get_local_ip, MODEL_PATH, MAX_UPLOAD_SIZE_BYTES

def main():
    local_ip = get_local_ip()
    
    print("\n" + "=" * 70)
    print("  ECOWING AI WASTE DETECTION & STREAMING SERVER")
    print("=" * 70)
    print(f"  [+] Host Local IP:            {local_ip}")
    print(f"  [+] Active YOLO Weights:      {MODEL_PATH.name}")
    print("=" * 70)
    print("  HOW TO CONNECT TO YOUR ECOWING WEBSITE:")
    print("=" * 70)
    print(f"  1. Live Video Stream URL:     http://{local_ip}:{DEFAULT_PORT}/video_feed")
    print(f"  2. Real-time Detections API:  http://{local_ip}:{DEFAULT_PORT}/api/detections")
    print(f"  3. WebSocket Telemetry:       ws://{local_ip}:{DEFAULT_PORT}/ws")
    print(f"  4. Web Control Dashboard:     http://{local_ip}:{DEFAULT_PORT}")
    print(f"     (Also accessible on:       http://localhost:{DEFAULT_PORT})")
    print(f"  5. Mobile Phone Camera Stream: http://{local_ip}:{DEFAULT_PORT}/mobile")
    print("=" * 70)
    print("  WEBSITE EMBED CODE (HTML):")
    print(f'     <img src="http://{local_ip}:{DEFAULT_PORT}/video_feed" width="100%" />')
    print("=" * 70 + "\n")

    uvicorn.run(
        "app:app",
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        reload=False,
        log_level="info",
        ws_max_size=MAX_UPLOAD_SIZE_BYTES
    )

if __name__ == "__main__":
    main()
