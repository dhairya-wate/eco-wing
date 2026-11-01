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
