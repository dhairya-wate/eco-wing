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
from app import app, worker, stream_mgr, detector
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
    Verifies that default cap is 5.0 FPS and the worker loop enforces the interval delay.
    """
    assert DETECTION_MAX_FPS == 5.0

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




def test_staleness_flag_lifecycle_and_worker_running(monkeypatch):
    """
    Stale flag lifecycle verified with real elapsed time.
    Stale flag becomes true when the worker is stopped past the threshold,
    and false when it is running.
    Verifies that:
    1. 'timestamp' is restored to its original type: Unix float.
    2. 'timestamp_iso' provides the ISO 8601 UTC string.
    3. 'age_seconds' is a non-negative float measured via real elapsed time.
    4. 'stale' is a boolean reflecting DETECTION_STALE_AFTER_SECONDS threshold.
    5. /api/system_info includes 'worker_running' boolean.
    6. Verifies state transitions using real elapsed clock time rather than manually mutating worker timestamps.
    """
    with TestClient(app) as client:
        # Use a short staleness threshold for real elapsed time verification
        monkeypatch.setattr("app.DETECTION_STALE_AFTER_SECONDS", 0.3)

        # 1. Running state: stale is False, age_seconds is low
        worker.start()
        time.sleep(0.15)
        res_active = client.get("/api/detections")
        assert res_active.status_code == 200
        body = res_active.json()

        # Type checks
        assert body.get("scope") == "live_frame"
        assert "timestamp" in body
        assert isinstance(body["timestamp"], float), f"Expected float timestamp, got {type(body['timestamp'])}"
        assert "timestamp_iso" in body
        assert isinstance(body["timestamp_iso"], str), f"Expected str timestamp_iso, got {type(body['timestamp_iso'])}"
        assert "+00:00" in body["timestamp_iso"] or "Z" in body["timestamp_iso"]

        assert "age_seconds" in body
        assert isinstance(body["age_seconds"], (int, float))
        assert "stale" in body
        assert isinstance(body["stale"], bool)
        assert body["stale"] is False
        assert body["age_seconds"] < 0.3

        # System info worker_running check
        res_info = client.get("/api/system_info", headers={"X-Operator-Token": TEST_OPERATOR_TOKEN})
        assert res_info.status_code == 200
        assert res_info.json()["worker_running"] is True

        # 2. Stopped state past threshold: stale becomes True via real elapsed time
        worker.stop()
        # Wait for real elapsed time to exceed the 0.3s staleness threshold
        time.sleep(0.35)

        res_stopped = client.get("/api/detections")
        assert res_stopped.status_code == 200
        stale_body = res_stopped.json()
        assert stale_body["stale"] is True
        assert stale_body["age_seconds"] >= 0.35
        assert isinstance(stale_body["timestamp"], float)
        assert isinstance(stale_body["timestamp_iso"], str)

        res_info_stopped = client.get("/api/system_info", headers={"X-Operator-Token": TEST_OPERATOR_TOKEN})
        assert res_info_stopped.json()["worker_running"] is False

        # 3. Resume worker and confirm it returns to fresh (stale is False) via real inference
        worker.start()
        time.sleep(0.2)
        res_resumed = client.get("/api/detections")
        assert res_resumed.status_code == 200
        resumed_body = res_resumed.json()
        assert resumed_body["stale"] is False
        assert resumed_body["age_seconds"] < 0.3




def test_all_confidence_values_within_zero_to_one():
    """
    Contract change: The detector stores and returns confidence as a float from 0.0 to 1.0.
    The percent conversion (0-100) has been removed from the API.
    All confidence values returned by the API and detector are strictly within [0.0, 1.0].
    """
    # 1. Check directly via WasteDetector
    detector = WasteDetector()
    blank_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    _, summary = detector.detect(blank_frame, draw_overlay=False)
    for item in summary["items"]:
        assert 0.0 <= item["confidence"] <= 1.0
        assert isinstance(item["confidence"], float)

    # 2. Check via /api/detections
    with TestClient(app) as client:
        res = client.get("/api/detections")
        assert res.status_code == 200
        items = res.json()["data"]["items"]
        for item in items:
            assert 0.0 <= item["confidence"] <= 1.0, f"API confidence {item['confidence']} outside [0.0, 1.0]"
            assert isinstance(item["confidence"], float)

    # 3. Check via /api/upload with real sample fixture
    fixture_path = SAMPLE_DIR / "fixtures" / "sample.jpg"
    if fixture_path.exists():
        with TestClient(app) as client:
            with open(fixture_path, "rb") as f:
                res_up = client.post(
                    "/api/upload",
                    headers={"X-Operator-Token": TEST_OPERATOR_TOKEN},
                    files={"file": ("sample.jpg", f.read(), "image/jpeg")}
                )
            assert res_up.status_code == 200
            for item in res_up.json()["analysis"]["items"]:
                assert 0.0 <= item["confidence"] <= 1.0, f"Upload confidence {item['confidence']} outside [0.0, 1.0]"
                assert isinstance(item["confidence"], float)


def test_settings_confidence_contract_accepts_unit_float_and_rejects_percentage():
    """
    POST /api/settings confidence contract:
    - Accepts standard unit float in [0.0, 1.0] (e.g. 0.5 sets threshold to 0.5).
    - Strictly rejects legacy percentage values (e.g. 50) and out-of-bounds numbers with HTTP 400.
    """
    with TestClient(app) as client:
        headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}

        # 1. Valid unit float 0.5 -> 200 OK
        res_valid = client.post("/api/settings", headers=headers, json={"confidence": 0.5})
        assert res_valid.status_code == 200
        assert res_valid.json()["confidence"] == 0.5
        assert detector.confidence == 0.5

        # 2. Legacy percentage value 50 -> 400 Bad Request
        res_pct = client.post("/api/settings", headers=headers, json={"confidence": 50})
        assert res_pct.status_code == 400
        assert "between 0.0 and 1.0" in res_pct.json()["detail"]

        # 3. Negative value -> 400 Bad Request
        res_neg = client.post("/api/settings", headers=headers, json={"confidence": -0.1})
        assert res_neg.status_code == 400

        # 4. Out of bounds > 1.0 -> 400 Bad Request
        res_high = client.post("/api/settings", headers=headers, json={"confidence": 1.5})
        assert res_high.status_code == 400

        # 5. Non-finite values: NaN, inf, -inf -> 400 Bad Request
        res_nan = client.post(
            "/api/settings",
            headers={**headers, "Content-Type": "application/json"},
            content=b'{"confidence": NaN}'
        )
        assert res_nan.status_code == 400

        res_inf = client.post(
            "/api/settings",
            headers={**headers, "Content-Type": "application/json"},
            content=b'{"confidence": Infinity}'
        )
        assert res_inf.status_code == 400

        res_neginf = client.post(
            "/api/settings",
            headers={**headers, "Content-Type": "application/json"},
            content=b'{"confidence": -Infinity}'
        )
        assert res_neginf.status_code == 400

        # Restore default confidence
        detector.set_confidence(0.35)


def test_contract_schema_and_taxonomy_validation():
    """
    Phase 1 Contract Validation:
    - taxonomy.yaml defines canonical class IDs in snake_case, allowed enums, and valid mappings.
    - detection-event.schema.json validates an authentic detection event emitted from detector fixture.
    - A payload with confidence 50 fails schema validation.
    - A payload with an unknown class_id fails schema validation.
    """
    import yaml
    import jsonschema
    from pathlib import Path

    contracts_dir = Path(__file__).resolve().parent / "contracts"
    if not contracts_dir.exists():
        contracts_dir = Path(__file__).resolve().parent.parent / "contracts"

    taxonomy_file = contracts_dir / "taxonomy.yaml"
    schema_file = contracts_dir / "detection-event.schema.json"

    assert taxonomy_file.exists(), f"Taxonomy file {taxonomy_file} does not exist"
    assert schema_file.exists(), f"Schema file {schema_file} does not exist"

    with open(taxonomy_file, "r", encoding="utf-8") as f:
        tax = yaml.safe_load(f)

    with open(schema_file, "r", encoding="utf-8") as f:
        det_schema = json.load(f)

    # 1. Validate taxonomy classes
    allowed_materials = set(tax["allowed_property_values"]["material"])
    allowed_rec = set(tax["allowed_property_values"]["recyclable"])
    allowed_bio = set(tax["allowed_property_values"]["biodegradable"])

    assert tax["taxonomy_version"] == "1.0.0"
    assert tax["classification_method"] == "coco_mapping"
    assert len(tax["classes"]) == 18

    for cid, cinfo in tax["classes"].items():
        assert cid == cinfo["class_id"]
        assert cid.islower() and " " not in cid
        assert cinfo["material"] in allowed_materials
        assert cinfo["recyclable"] in allowed_rec
        assert cinfo["biodegradable"] in allowed_bio

    # 2. Check draft-07 schema validity
    jsonschema.Draft7Validator.check_schema(det_schema)

    # 3. Create valid fixture representing detector output
    valid_event = {
        "event_id": "12345678-1234-4234-8234-123456789abc",
        "drone_id": "Drone-01",
        "source": "camera",
        "observed_at": "2026-11-01T09:20:00Z",
        "taxonomy_version": "1.0.0",
        "classification_method": "coco_mapping",
        "items": [
            {
                "class_id": "bottle",
                "coco_label": "bottle",
                "confidence": 0.85,
                "bbox": [10.0, 15.0, 120.0, 240.0],
                "category": "Container",
                "material": "unknown",
                "recyclable": "depends",
                "biodegradable": "no"
            }
        ]
    }
    jsonschema.validate(instance=valid_event, schema=det_schema)

    # 4. Payload with confidence 50 must fail schema validation
    bad_conf = dict(valid_event)
    bad_conf["items"] = [dict(valid_event["items"][0], confidence=50)]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad_conf, schema=det_schema)

    # 5. Payload with unknown class_id must fail schema validation
    bad_class = dict(valid_event)
    bad_class["items"] = [dict(valid_event["items"][0], class_id="plastic_bag_unknown")]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad_class, schema=det_schema)

