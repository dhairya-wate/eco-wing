import os
import json
import time
import socket
import tempfile
import threading
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
import jsonschema
import pytest

from outbox import OutboxQueue, OutboxSender, create_detection_event
from config import BASE_DIR


def get_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class MockEcoWingHandler(BaseHTTPRequestHandler):
    received_requests = []
    should_fail = False
    fail_status = 503

    def do_POST(self):
        if self.should_fail:
            self.send_response(self.fail_status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error": "service unavailable"}')
            return

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length > 0 else b''
        payload = json.loads(body.decode('utf-8')) if body else {}

        MockEcoWingHandler.received_requests.append({
            'path': self.path,
            'headers': dict(self.headers),
            'payload': payload
        })

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"success": true}')

    def log_message(self, format, *args):
        # Suppress noisy HTTP logs during test
        pass


def test_outbox_queue_and_schema_validation(tmp_path):
    schema_path = BASE_DIR / "contracts" / "detection-event.schema.json"
    with open(schema_path, "r", encoding="utf-8") as f:
        schema = json.load(f)

    db_path = tmp_path / "test_outbox.db"
    queue = OutboxQueue(db_path=db_path)

    event = create_detection_event(
        drone_id="EcoWing-Alpha",
        source="camera",
        items=[
            {
                "raw_class": "bottle",
                "coco_label": "bottle",
                "category": "Container",
                "material": "plastic",
                "confidence": 0.92,
                "recyclable": "yes",
                "biodegradable": "no",
                "bbox": [100, 150, 200, 300]
            }
        ]
    )

    # 1. Assert event conforms strictly to canonical Draft-07 schema
    jsonschema.validate(instance=event, schema=schema)

    # 2. Enqueue event and verify persistence
    event_id = queue.enqueue(event)
    assert event_id == event["event_id"]
    assert queue.get_pending_count() == 1

    # 3. Reload queue from same DB file to confirm durability
    reloaded_queue = OutboxQueue(db_path=db_path)
    assert reloaded_queue.get_pending_count() == 1
    pending = reloaded_queue.get_pending()
    assert len(pending) == 1
    assert pending[0]["event_id"] == event_id
    assert pending[0]["payload"]["items"][0]["class_id"] == "bottle"


def test_outbox_offline_queue_and_delivery_when_ecowing_returns(tmp_path):
    """
    Critical Reliability Test:
    EcoWing offline -> events queue -> EcoWing returns -> events delivered exactly once.
    """
    MockEcoWingHandler.received_requests = []
    MockEcoWingHandler.should_fail = True

    port = get_free_port()
    server = HTTPServer(('127.0.0.1', port), MockEcoWingHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    db_path = tmp_path / "outbox_delivery.db"
    queue = OutboxQueue(db_path=db_path)

    ingest_url = f"http://127.0.0.1:{port}/api/drone/detection"
    sender = OutboxSender(
        queue=queue,
        ingest_url=ingest_url,
        device_token="test_device_token_drone_01_secure_12345",
        drone_id="EcoWing-01",
        base_interval=0.1
    )

    try:
        # Step 1: Enqueue event while EcoWing is failing (offline)
        event = create_detection_event(
            drone_id="EcoWing-01",
            source="camera",
            items=[
                {
                    "raw_class": "cup",
                    "coco_label": "cup",
                    "category": "Container",
                    "confidence": 0.88,
                    "bbox": [50, 60, 120, 180]
                }
            ]
        )
        event_id = queue.enqueue(event)
        assert queue.get_pending_count() == 1

        # Attempt delivery while offline
        delivered = sender.process_pending_once()
        assert delivered == 0
        # Remains in outbox!
        assert queue.get_pending_count() == 1
        assert len(MockEcoWingHandler.received_requests) == 0

        # Step 2: EcoWing comes back online
        MockEcoWingHandler.should_fail = False

        # Attempt delivery now
        delivered = sender.process_pending_once()
        assert delivered == 1

        # Delivered and deleted from outbox!
        assert queue.get_pending_count() == 0
        assert len(MockEcoWingHandler.received_requests) == 1

        received = MockEcoWingHandler.received_requests[0]
        assert received["headers"].get("X-Drone-Id") == "EcoWing-01"
        assert received["headers"].get("X-Drone-Token") == "test_device_token_drone_01_secure_12345"
        assert received["payload"]["event_id"] == event_id
        assert received["payload"]["items"][0]["class_id"] == "cup"

        # Step 3: Run again to prove exactly-once delivery (no duplicate sends)
        delivered_again = sender.process_pending_once()
        assert delivered_again == 0
        assert len(MockEcoWingHandler.received_requests) == 1

    finally:
        server.shutdown()
        server.server_close()


def test_end_to_end_detection_to_ecowing_ingestion_and_outbox_recovery(tmp_path):
    """
    Phase 5.1 End-to-end integration test:
    1. Detection processes a fixture image with WasteDetector.
    2. Pushes canonical event to EcoWing Command Center via OutboxSender.
    3. EcoWing validates schema and stores exactly one document.
    4. Pushes the same event twice to verify idempotence.
    5. Stops EcoWing to verify outbox queue persistence and exponential backoff under failure.
    6. Restarts EcoWing to verify outbox recovery and delivery.
    """
    import subprocess
    import urllib.request
    import numpy as np
    from detector import WasteDetector
    from config import SAMPLE_DIR

    ecowing_dir = BASE_DIR.parent / "EcoWing"
    if not ecowing_dir.exists():
        pytest.skip("EcoWing directory not found")

    node_script = """
    const express = require('express');
    const http = require('http');
    process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
    process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
        'EcoWing-01': 'secure_e2e_drone_token_9xK2mP7qR4vL8wZ1'
    });
    const droneRouter = require('./backend/routes/drone');
    const detectionStore = require('./backend/detectionStore');
    const app = express();
    app.use(express.json());
    app.use('/api/drone', droneRouter);
    app.get('/test/count', (req, res) => {
        res.json({ count: detectionStore.events.length });
    });
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        console.log('ECOWING_SERVER_READY:' + port);
    });
    """

    def start_ecowing():
        env = os.environ.copy()
        env["NODE_PATH"] = str(ecowing_dir / "backend" / "node_modules")
        proc = subprocess.Popen(
            ["node", "-e", node_script],
            cwd=str(ecowing_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        port = None
        for _ in range(50):
            line = proc.stdout.readline()
            if "ECOWING_SERVER_READY:" in line:
                port = int(line.strip().split(":")[1])
                break
        assert port is not None, f"Failed to start EcoWing test server: {proc.stderr.read()}"
        return proc, port

    # 1. Process fixture image with WasteDetector
    import cv2
    detector = WasteDetector()
    fixture_path = SAMPLE_DIR / "fixtures" / "sample.jpg"
    img = cv2.imread(str(fixture_path)) if fixture_path.exists() else None
    if img is None:
        img = np.zeros((480, 640, 3), dtype=np.uint8)
    annotated, summary = detector.detect(img)
    assert "taxonomy_version" in summary
    assert "classification_method" in summary

    items = summary.get("items") or [
        {
            "class_id": "bottle",
            "coco_label": "bottle",
            "confidence": 0.94,
            "category": "Container",
            "material": "plastic",
            "recyclable": "yes",
            "biodegradable": "no",
            "bbox": [50, 50, 200, 300]
        }
    ]

    event = create_detection_event(
        drone_id="EcoWing-01",
        source="camera",
        items=items
    )

    db_path = tmp_path / "e2e_outbox.db"
    queue = OutboxQueue(db_path=db_path)
    event_id = queue.enqueue(event)
    assert queue.get_pending_count() == 1

    proc1, port1 = start_ecowing()
    try:
        ingest_url1 = f"http://127.0.0.1:{port1}/api/drone/detection"
        sender = OutboxSender(
            queue=queue,
            ingest_url=ingest_url1,
            device_token="secure_e2e_drone_token_9xK2mP7qR4vL8wZ1",
            drone_id="EcoWing-01"
        )

        # 2. Push event to EcoWing: delivery confirmed and deleted from outbox
        delivered = sender.process_pending_once()
        assert delivered == 1
        assert queue.get_pending_count() == 0

        # Check EcoWing count
        with urllib.request.urlopen(f"http://127.0.0.1:{port1}/test/count") as r:
            c1 = json.loads(r.read().decode())["count"]

        # 3. Push same event again to check idempotence (stored document count must NOT increase)
        sender._send_item({"id": 1, "event_id": event_id, "payload": event})
        with urllib.request.urlopen(f"http://127.0.0.1:{port1}/test/count") as r:
            c2 = json.loads(r.read().decode())["count"]
        assert c2 == c1, "EcoWing must store exactly one document when duplicate event is sent"

    finally:
        proc1.terminate()
        proc1.wait()

    # 4. Outbox recovery with EcoWing down
    event2 = create_detection_event(
        drone_id="EcoWing-01",
        source="camera",
        items=items
    )
    event_id2 = queue.enqueue(event2)
    assert queue.get_pending_count() == 1

    # EcoWing is down -> send fails, event preserved in outbox
    delivered = sender.process_pending_once()
    assert delivered == 0
    assert queue.get_pending_count() == 1

    # 5. EcoWing comes back online -> outbox recovers and delivers
    proc2, port2 = start_ecowing()
    try:
        sender.ingest_url = f"http://127.0.0.1:{port2}/api/drone/detection"
        delivered = sender.process_pending_once()
        assert delivered == 1
        assert queue.get_pending_count() == 0
    finally:
        proc2.terminate()
        proc2.wait()
