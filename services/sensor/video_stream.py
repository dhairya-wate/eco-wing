import cv2
import threading
import time
import numpy as np
from pathlib import Path
from config import SAMPLE_DIR

class VideoStreamManager:
    def __init__(self, source="0"):
        self.source = str(source)
        self.cap = None
        self.is_running = False
        self.lock = threading.Lock()
        self.current_frame = None
        self.is_simulator = False
        self.thread = None
        self.sample_images = []
        self.sim_index = 0
        self.last_sim_switch = 0
        
        # Mobile streaming state
        self.mobile_frame = None
        self.last_mobile_time = 0
        self.mobile_timeout = 3.0 # seconds before reverting to local source
        
        self._load_sample_images()
        self.start()

    def _load_sample_images(self):
        """Loads any test images from the sample directory for simulation fallback."""
        if SAMPLE_DIR.exists():
            for p in sorted(SAMPLE_DIR.glob("*.*")):
                if p.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"]:
                    img = cv2.imread(str(p))
                    if img is not None:
                        img = cv2.resize(img, (640, 480))
                        self.sample_images.append(img)

    def _init_capture(self):
        """Attempts to open the requested video source or falls back to simulator."""
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None

        self.is_simulator = False
        src_str = str(self.source).strip().lower()

        if src_str in ["simulator", "demo", "sim", "mobile"]:
            self.is_simulator = True
            return

        is_num = src_str.isdigit()
        if is_num:
            cam_idx = int(src_str)
            print(f"[VideoStream] Connecting to webcam index {cam_idx}...")
            self.cap = cv2.VideoCapture(cam_idx)
        else:
            print(f"[VideoStream] Connecting to stream/file: {self.source}...")
            self.cap = cv2.VideoCapture(self.source)

        if not self.cap or not self.cap.isOpened():
            print(f"[VideoStream] Source '{self.source}' not accessible. Falling back to DEMO SIMULATOR.")
            self.is_simulator = True
            if self.cap is not None:
                try:
                    self.cap.release()
                except Exception:
                    pass
                self.cap = None
        else:
            print(f"[VideoStream] Successfully opened: {self.source}")
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    def start(self):
        if self.is_running:
            return
        self.is_running = True
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()

    def set_source(self, new_source):
        with self.lock:
            self.source = str(new_source)
            self._init_capture()

    def update_mobile_frame(self, frame_np):
        """Called whenever a mobile device pushes a new video frame."""
        with self.lock:
            self.mobile_frame = frame_np
            self.last_mobile_time = time.time()

    def has_active_mobile_stream(self):
        return (time.time() - self.last_mobile_time) < self.mobile_timeout

    def _capture_loop(self):
        self._init_capture()
        while self.is_running:
            # If mobile camera is currently transmitting, prioritize mobile frame
            if self.has_active_mobile_stream():
                with self.lock:
                    if self.mobile_frame is not None:
                        self.current_frame = self.mobile_frame.copy()
                time.sleep(0.02)
                continue

            if not self.is_simulator and self.cap is not None and self.cap.isOpened():
                success, frame = self.cap.read()
                if success and frame is not None:
                    with self.lock:
                        self.current_frame = frame
                    time.sleep(0.015)
                else:
                    if not str(self.source).isdigit():
                        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        time.sleep(0.03)
                    else:
                        time.sleep(0.05)
            else:
                frame = self._generate_simulated_frame()
                with self.lock:
                    self.current_frame = frame
                time.sleep(0.04)

    def _generate_simulated_frame(self):
        """Generates dynamic waste simulation frames when physical camera is offline."""
        now = time.time()
        
        # If we have sample waste images loaded, rotate between them
        if len(self.sample_images) > 0:
            if now - self.last_sim_switch > 3.5:
                self.sim_index = (self.sim_index + 1) % len(self.sample_images)
                self.last_sim_switch = now
            base = self.sample_images[self.sim_index].copy()
            h, w = base.shape[:2]
            scan_y = int((now * 160) % h)
            cv2.line(base, (0, scan_y), (w, scan_y), (16, 185, 129), 2)
            return base

        # Default fallback frame
        frame = np.full((480, 640, 3), (25, 28, 34), dtype=np.uint8)
        cv2.putText(frame, "ECOWING STREAM ACTIVE", (160, 220), 
                    cv2.FONT_HERSHEY_DUPLEX, 0.8, (16, 185, 129), 2)
        cv2.putText(frame, "Connect mobile phone or webcam", (180, 260), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (160, 160, 160), 1)
        return frame

    def get_frame(self):
        with self.lock:
            if self.current_frame is not None:
                return self.current_frame.copy()
            return self._generate_simulated_frame()

    def stop(self):
        self.is_running = False
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
