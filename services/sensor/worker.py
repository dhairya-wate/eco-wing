import time
import threading
import logging
import cv2
from typing import Optional, Dict, Any, Tuple
from config import TAXONOMY_VERSION, CLASSIFICATION_METHOD, DETECTION_MAX_FPS

logger = logging.getLogger("ecowing.worker")


class DetectionWorker:
    """
    Dedicated background detection worker.
    
    Architecture & Thread Safety:
    - Frame Acquisition: Reads frames from the active VideoStreamManager source.
    - Lock Scope:
      * YOLO inference (self.detector.detect) and JPEG encoding (cv2.imencode) execute
        OUTSIDE the thread lock (self.lock).
      * The lock is held ONLY during rapid state snapshot updates and reads
        (latest_frame, latest_jpeg, latest_summary, last_update_time, inference_count).
      * This ensures that API callers and MJPEG streaming viewers are never blocked by
        PyTorch or OpenCV model inference computations.
    - Source Failure Behavior:
      * If stream_manager returns None or an empty frame, the worker logs a warning,
        leaves existing detection state intact, and sleeps until the next frame interval.
      * If any unexpected exception occurs during frame acquisition or inference,
        it is caught, logged with exc_info, and does not terminate the worker thread.
    - Shutdown:
      * stop() signals the worker by acquiring the lock, clearing self.is_running,
        and joining the background thread with a 2.0-second timeout.
    - Frame-Rate Cap:
      * Governed by DETECTION_MAX_FPS (default 30.0 FPS).
      * The loop dynamically computes elapsed processing time and sleeps for the
        remainder of the frame interval: max(0.001, (1.0 / self.fps_limit) - elapsed).
    """

    def __init__(self, detector, stream_mgr, watermark: str = "127.0.0.1:5000", fps_limit: float = DETECTION_MAX_FPS):
        self.detector = detector
        self.stream_mgr = stream_mgr
        self.watermark = watermark
        self.fps_limit = max(1.0, float(fps_limit))
        self.interval = 1.0 / self.fps_limit
        self.is_running = False
        self.thread: Optional[threading.Thread] = None
        self.lock = threading.Lock()
        self.inference_count = 0
        self.last_update_time = time.time()
        self.latest_frame = None
        self.latest_jpeg = None
        self.latest_summary = {
            "taxonomy_version": TAXONOMY_VERSION,
            "classification_method": CLASSIFICATION_METHOD,
            "total_count": 0,
            "recyclable_count": 0,
            "non_recyclable_count": 0,
            "biodegradable_count": 0,
            "non_biodegradable_count": 0,
            "items": [],
            "timestamp": time.time()
        }

    def start(self):
        """Starts the background detection worker thread if not already running."""
        with self.lock:
            if self.is_running:
                return
            self.is_running = True
            self.thread = threading.Thread(target=self._run_loop, daemon=True, name="DetectionWorkerThread")
            self.thread.start()

    def stop(self):
        """Signals the background detection worker thread to stop and waits for exit."""
        with self.lock:
            self.is_running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2.0)

    def _run_loop(self):
        """Continuous detection loop running at capped frame rate."""
        while self.is_running:
            t0 = time.time()
            try:
                frame = self.stream_mgr.get_frame()
                if frame is not None and frame.size > 0:
                    # Run YOLO inference OUTSIDE lock to avoid blocking API readers
                    annotated_frame, summary = self.detector.detect(
                        frame,
                        draw_overlay=True,
                        server_info=self.watermark
                    )
                    ret, buffer = cv2.imencode('.jpg', annotated_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                    jpeg_bytes = buffer.tobytes() if ret else None

                    now = time.time()
                    with self.lock:
                        self.latest_frame = annotated_frame
                        self.latest_jpeg = jpeg_bytes
                        self.latest_summary = summary
                        self.last_update_time = now
                        self.inference_count += 1
                else:
                    # Source failure / offline camera: log warning and continue safely
                    logger.warning("VideoStreamManager returned empty or None frame in DetectionWorker loop.")
            except Exception as e:
                # Catch-all to prevent thread crash; server logs details
                logger.error("Error in DetectionWorker loop: %s", e, exc_info=True)

            elapsed = time.time() - t0
            sleep_time = max(0.001, (1.0 / self.fps_limit) - elapsed)
            time.sleep(sleep_time)

    def get_latest_summary(self) -> Dict[str, Any]:
        """Returns a snapshot of the latest detection summary under lock."""
        with self.lock:
            return self.latest_summary.copy()

    def get_latest_summary_and_update_time(self) -> Tuple[Dict[str, Any], float]:
        """Returns a snapshot of the latest detection summary and its update timestamp under lock."""
        with self.lock:
            return self.latest_summary.copy(), self.last_update_time

    def get_latest_jpeg(self) -> Optional[bytes]:
        """Returns the pre-encoded JPEG bytes of the latest annotated frame under lock."""
        with self.lock:
            return self.latest_jpeg
