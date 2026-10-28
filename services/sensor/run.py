import sys

# Ensure UTF-8 output on Windows consoles
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

import uvicorn
from config import DEFAULT_HOST, DEFAULT_PORT, get_local_ip, MODEL_PATH

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

    uvicorn.run("app:app", host=DEFAULT_HOST, port=DEFAULT_PORT, reload=False, log_level="info")

if __name__ == "__main__":
    main()
