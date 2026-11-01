import time
import threading
import urllib.request
import json
import pytest
import numpy as np
import uvicorn
from starlette.testclient import TestClient
from ultralytics import YOLO

import config
from config import (
    COCO_WASTE_MAPPING,
    ALLOWED_CLASSIFICATION_VALUES,
    TAXONOMY_VERSION,
    CLASSIFICATION_METHOD,
    resolve_waste_item,
    MODEL_PATH,
    SAMPLE_DIR,
    DETECTION_MAX_FPS
)
from detector import WasteDetector
from worker import DetectionWorker
from app import app, worker, stream_mgr
from conftest import TEST_OPERATOR_TOKEN


def test_every_mapping_coco_label_exists_in_model_classes():
    """Every entry in COCO_WASTE_MAPPING must match an authentic class in the YOLO model."""
    detector = WasteDetector()
    model_classes = set(detector.model.names.values())

    for coco_label, entry in COCO_WASTE_MAPPING.items():
        assert coco_label in model_classes, f"Mapping label '{coco_label}' not found in YOLO model classes!"
        assert entry["coco_label"] == coco_label
        assert entry["model_supported"] is True
        assert entry["classification_method"] == "coco_mapping"
        assert entry["material"] == "unknown"


def test_recyclable_and_biodegradable_allowed_enum_values():
    """All recyclable and biodegradable properties must strictly use allowed enum values."""
    for label, entry in COCO_WASTE_MAPPING.items():
        rec = entry.get("recyclable")
        bio = entry.get("biodegradable")
        assert rec in ALLOWED_CLASSIFICATION_VALUES, (
            f"Invalid recyclable value '{rec}' for '{label}'. Allowed: {ALLOWED_CLASSIFICATION_VALUES}"
        )
        assert bio in ALLOWED_CLASSIFICATION_VALUES, (
            f"Invalid biodegradable value '{bio}' for '{label}'. Allowed: {ALLOWED_CLASSIFICATION_VALUES}"
        )


def test_unmapped_coco_labels_produce_no_waste_items():
    """
    Unmapped COCO labels (e.g. person, car, dog, airplane) must return None
    from resolve_waste_item and must produce no waste detections.
    Also verifies the system does not claim the model detects unmapped materials
    like paper, glass, cans, or plastic directly.
    """
    unmapped_labels = [
        "person", "car", "dog", "airplane", "bicycle", "chair", "sofa",
        # Non-COCO raw material labels that the model does not directly detect:
        "paper", "glass", "can", "cans", "plastic", "metal", "cardboard", "trash"
    ]
    for label in unmapped_labels:
        assert resolve_waste_item(label) is None, f"Expected unmapped label '{label}' to resolve to None"


def test_waste_detector_summary_contains_taxonomy_and_method():
    """WasteDetector output summary includes taxonomy_version and classification_method."""
    detector = WasteDetector()
    blank_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    _, summary = detector.detect(blank_frame, draw_overlay=False)

    assert summary["taxonomy_version"] == TAXONOMY_VERSION
    assert summary["classification_method"] == CLASSIFICATION_METHOD
    assert summary["total_count"] == 0
    assert summary["items"] == []


def test_worker_updates_results_with_zero_viewers():
    """Worker updates detection results even with zero /video_feed viewers (using simulator)."""
    stream_mgr.set_source("simulator")
    worker.start()

    initial_count = worker.inference_count
    # Wait for background worker to process frames
    time.sleep(0.3)

    with TestClient(app) as client:
        res = client.get("/api/detections")
        assert res.status_code == 200
        data = res.json()["data"]
        assert "taxonomy_version" in data
        assert "classification_method" in data
        assert worker.inference_count > initial_count
        assert worker.get_latest_jpeg() is not None


def test_detector_calls_do_not_scale_with_viewers(monkeypatch):
    """
    Detector call count does NOT scale with the number of /video_feed viewers.
    With background worker, the detector runs at fixed frequency regardless of 1 vs 3 viewers.
    """
    stream_mgr.set_source("simulator")
    worker.start()

    detect_calls = 0
    orig_detect = worker.detector.detect

    def counted_detect(*args, **kwargs):
        nonlocal detect_calls
        detect_calls += 1
        return orig_detect(*args, **kwargs)

    monkeypatch.setattr(worker.detector, "detect", counted_detect)

    port = 5996
    server_cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    srv = uvicorn.Server(server_cfg)
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    time.sleep(0.8)

    def read_stream(duration=0.3):
        try:
            req = urllib.request.urlopen(f"http://127.0.0.1:{port}/video_feed", timeout=5)
            t_end = time.time() + duration
            while time.time() < t_end:
                chunk = req.read(2048)
                if not chunk:
                    break
            req.close()
        except Exception:
            pass

    try:
        # 1 Viewer test
        detect_calls = 0
        read_stream(0.3)
        c1 = detect_calls

        # 3 Viewers test
        detect_calls = 0
        threads = [threading.Thread(target=read_stream, args=(0.3,)) for _ in range(3)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        c3 = detect_calls

        # Detector calls must not scale with 3x viewers (would be ~3*c1 if per-viewer)
        assert c3 <= max(c1 * 1.6, 5) + 3, (
            f"Expected calls with 3 viewers ({c3}) not to scale 3x over 1 viewer ({c1})"
        )
    finally:
        srv.should_exit = True
        t.join(timeout=2.0)


def test_mobile_stream_frame_produces_detection_with_zero_viewers():
    """
    Requirement B:
    The mobile phone path feeds frames through stream_mgr.update_mobile_frame().
    The background worker must read from that same source when the mobile stream is active.
    Verify that a frame sent via /ws/mobile_stream produces a detection result with zero /video_feed viewers.
    """
    # 1. Start worker and verify it is running
    worker.start()
    assert worker.is_running is True

    # 2. Authenticate and obtain mobile pairing session
    with TestClient(app) as client:
        # Create pairing code with operator token
        res_code = client.post("/api/mobile/pairing_code", headers={"X-Operator-Token": TEST_OPERATOR_TOKEN})
        assert res_code.status_code == 200
        code = res_code.json()["pairing_code"]

        # Exchange pairing code for session token
        res_ex = client.post("/api/mobile/exchange", json={"code": code})
        assert res_ex.status_code == 200
        session_token = res_ex.json()["session_token"]

        # Load valid JPEG frame fixture
        fixture_path = SAMPLE_DIR / "fixtures" / "sample.jpg"
        assert fixture_path.exists(), f"Fixture {fixture_path} not found"
        frame_bytes = fixture_path.read_bytes()

        # Connect WebSocket with zero /video_feed viewers
        with client.websocket_connect("/ws/mobile_stream") as ws:
            # Complete in-band auth handshake
            ws.send_text(json.dumps({"type": "auth", "session": session_token}))
            auth_ack = json.loads(ws.receive_text())
            assert auth_ack["type"] == "auth_ok"

            # Send binary image frame over mobile stream
            ws.send_bytes(frame_bytes)
            feedback = json.loads(ws.receive_text())
            assert feedback["type"] == "detection_feedback"

            # Verify stream manager acknowledges active mobile stream
            assert stream_mgr.has_active_mobile_stream() is True

            # Allow worker loop to ingest the mobile frame and run inference
            time.sleep(0.2)

            # Assert detection results are produced with zero /video_feed viewers
            summary = worker.get_latest_summary()
            assert "items" in summary
            assert "total_count" in summary
            assert "taxonomy_version" in summary
            assert summary["taxonomy_version"] == TAXONOMY_VERSION

            # Verify public /api/detections also reflects the worker's detections
            res_det = client.get("/api/detections")
            assert res_det.status_code == 200
            det_data = res_det.json()
            assert det_data["data"]["taxonomy_version"] == TAXONOMY_VERSION


def test_worker_frame_rate_cap_respects_max_fps():
    """
    Worker frame-rate cap respects DETECTION_MAX_FPS.
    Verifies that the worker loop enforces the interval delay and does not exceed the configured FPS.
    """
    # Create an isolated worker configured with 10 FPS cap
    custom_worker = DetectionWorker(
        detector=WasteDetector(),
        stream_mgr=stream_mgr,
        fps_limit=10.0
    )
    assert custom_worker.fps_limit == 10.0
    assert abs(custom_worker.interval - 0.1) < 0.001

    try:
        custom_worker.start()
        # Measure inferences over 0.4 seconds
        t_start = time.time()
        start_count = custom_worker.inference_count
        time.sleep(0.4)
        elapsed = time.time() - t_start
        total_inferences = custom_worker.inference_count - start_count

        # At 10 FPS over ~0.4s, maximum possible inferences is <= 10 * elapsed + 1
        max_allowed = int(10.0 * elapsed) + 2
        assert total_inferences <= max_allowed, (
            f"Worker exceeded FPS cap: {total_inferences} inferences in {elapsed:.2f}s (cap 10 FPS)"
        )
    finally:
        custom_worker.stop()
