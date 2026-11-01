import os
import json
import time
import uuid
import sqlite3
import logging
import threading
import urllib.request
import urllib.error
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime, timezone

from config import (
    BASE_DIR,
    TAXONOMY_VERSION,
    CLASSIFICATION_METHOD
)

logger = logging.getLogger("ecowing.outbox")

DEFAULT_OUTBOX_PATH = BASE_DIR / "data" / "outbox.db"


def create_detection_event(
    drone_id: str,
    source: str,
    items: List[Dict[str, Any]],
    event_id: Optional[str] = None,
    observed_at: Optional[str] = None
) -> Dict[str, Any]:
    """
    Constructs a detection event dict matching contracts/detection-event.schema.json.
    """
    if not event_id:
        event_id = str(uuid.uuid4())
    if not observed_at:
        observed_at = datetime.now(timezone.utc).isoformat()

    formatted_items = []
    for it in items:
        raw_label = it.get("coco_label") or it.get("raw_class") or it.get("class_name") or "bottle"
        class_id = raw_label.strip().lower().replace(" ", "_")
        conf = float(it.get("confidence", 0.0))
        bbox = it.get("bbox", [0, 0, 0, 0])

        item_dict = {
            "class_id": class_id,
            "coco_label": raw_label,
            "confidence": round(conf, 4),
            "bbox": bbox
        }
        if "category" in it:
            item_dict["category"] = str(it["category"])
        if "material" in it:
            item_dict["material"] = str(it["material"])
        if "recyclable" in it:
            item_dict["recyclable"] = str(it["recyclable"]).lower()
        if "biodegradable" in it:
            item_dict["biodegradable"] = str(it["biodegradable"]).lower()

        formatted_items.append(item_dict)

    return {
        "event_id": event_id,
        "drone_id": str(drone_id),
        "source": str(source),
        "observed_at": observed_at,
        "taxonomy_version": TAXONOMY_VERSION,
        "classification_method": CLASSIFICATION_METHOD,
        "items": formatted_items
    }


class OutboxQueue:
    """
    Thread-safe SQLite persistent outbox queue for reliable event delivery.
    """

    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = Path(db_path or os.getenv("OUTBOX_DB_PATH", str(DEFAULT_OUTBOX_PATH)))
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self.lock:
            with self._get_connection() as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS outbox (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_id TEXT UNIQUE NOT NULL,
                        payload TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        attempts INTEGER NOT NULL DEFAULT 0,
                        last_attempt_at REAL,
                        created_at REAL NOT NULL
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status);")
                conn.commit()

    def enqueue(self, event: Dict[str, Any]) -> str:
        """
        Enqueues a canonical detection event payload into SQLite.
        Returns the event_id.
        """
        event_id = event.get("event_id") or str(uuid.uuid4())
        event["event_id"] = event_id
        payload_json = json.dumps(event)
        now = time.time()

        with self.lock:
            with self._get_connection() as conn:
                conn.execute("""
                    INSERT INTO outbox (event_id, payload, status, attempts, created_at)
                    VALUES (?, ?, 'pending', 0, ?);
                """, (event_id, payload_json, now))
                conn.commit()

        logger.debug("Enqueued event %s to outbox", event_id)
        return event_id

    def get_pending(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Retrieves up to `limit` pending outbox records."""
        with self.lock:
            with self._get_connection() as conn:
                cursor = conn.execute("""
                    SELECT id, event_id, payload, attempts, last_attempt_at, created_at
                    FROM outbox
                    WHERE status = 'pending'
                    ORDER BY id ASC
                    LIMIT ?;
                """, (limit,))
                rows = cursor.fetchall()
                results = []
                for r in rows:
                    results.append({
                        "id": r["id"],
                        "event_id": r["event_id"],
                        "payload": json.loads(r["payload"]),
                        "attempts": r["attempts"],
                        "last_attempt_at": r["last_attempt_at"],
                        "created_at": r["created_at"]
                    })
                return results

    def mark_sent(self, record_id: int):
        """Deletes the event record from outbox upon confirmed 2xx delivery."""
        with self.lock:
            with self._get_connection() as conn:
                conn.execute("DELETE FROM outbox WHERE id = ?;", (record_id,))
                conn.commit()
        logger.debug("Deleted delivered outbox record id=%d", record_id)

    def record_attempt_failure(self, record_id: int):
        """Increments attempt count and updates last_attempt_at timestamp."""
        now = time.time()
        with self.lock:
            with self._get_connection() as conn:
                conn.execute("""
                    UPDATE outbox
                    SET attempts = attempts + 1, last_attempt_at = ?
                    WHERE id = ?;
                """, (now, record_id))
                conn.commit()

    def get_pending_count(self) -> int:
        """Returns total number of pending events in outbox."""
        with self.lock:
            with self._get_connection() as conn:
                cursor = conn.execute("SELECT COUNT(*) as cnt FROM outbox WHERE status = 'pending';")
                row = cursor.fetchone()
                return int(row["cnt"]) if row else 0

    def clear(self):
        """Clears all records in outbox."""
        with self.lock:
            with self._get_connection() as conn:
                conn.execute("DELETE FROM outbox;")
                conn.commit()


class OutboxSender:
    """
    Background worker that reliably transmits pending outbox events to EcoWing Command Center.
    - Pushes to EcoWing ingestion endpoint with 'X-Drone-Token' and 'X-Drone-Id'.
    - Implements exponential backoff on connection errors / failures.
    - Deletes from outbox strictly on 2xx responses.
    """

    def __init__(
        self,
        queue: OutboxQueue,
        ingest_url: Optional[str] = None,
        device_token: Optional[str] = None,
        drone_id: Optional[str] = None,
        base_interval: float = 1.0,
        max_backoff: float = 30.0
    ):
        self.queue = queue
        self.ingest_url = ingest_url or os.getenv("ECOWING_INGEST_URL", "")
        self.device_token = device_token or os.getenv("ECOWING_DEVICE_TOKEN", "")
        self.drone_id = drone_id or os.getenv("DRONE_ID", "EcoWing-01")
        self.base_interval = base_interval
        self.max_backoff = max_backoff
        self.is_running = False
        self.thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._current_backoff = base_interval

    def start(self):
        if self.is_running:
            return
        self.is_running = True
        self._stop_event.clear()
        self.thread = threading.Thread(target=self._run_loop, daemon=True, name="OutboxSenderThread")
        self.thread.start()
        logger.info("OutboxSender started. Target: %s", self.ingest_url or "(none)")

    def stop(self):
        self.is_running = False
        self._stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2.0)
        logger.info("OutboxSender stopped.")

    def process_pending_once(self) -> int:
        """
        Attempts to deliver pending outbox items synchronously.
        Returns number of successfully sent and deleted events.
        """
        if not self.ingest_url:
            return 0

        pending_items = self.queue.get_pending(limit=20)
        if not pending_items:
            self._current_backoff = self.base_interval
            return 0

        delivered_count = 0
        for item in pending_items:
            success = self._send_item(item)
            if success:
                self.queue.mark_sent(item["id"])
                delivered_count += 1
                self._current_backoff = self.base_interval
            else:
                self.queue.record_attempt_failure(item["id"])
                # Apply exponential backoff and break to preserve in-order transmission
                self._current_backoff = min(self.max_backoff, self._current_backoff * 2.0)
                break

        return delivered_count

    def _send_item(self, item: Dict[str, Any]) -> bool:
        payload_data = item["payload"]
        data_bytes = json.dumps(payload_data).encode("utf-8")

        headers = {
            "Content-Type": "application/json",
            "X-Drone-Id": self.drone_id,
            "X-Drone-Token": self.device_token
        }

        req = urllib.request.Request(
            url=self.ingest_url,
            data=data_bytes,
            headers=headers,
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                status_code = resp.getcode()
                if 200 <= status_code < 300:
                    return True
                logger.warning("EcoWing returned non-2xx status: %d", status_code)
                return False
        except urllib.error.HTTPError as e:
            if 200 <= e.code < 300:
                return True
            logger.warning("HTTP error delivering event %s: %s", item["event_id"], e)
            return False
        except Exception as e:
            logger.warning("Network error delivering event %s: %s", item["event_id"], e)
            return False

    def _run_loop(self):
        while not self._stop_event.is_set():
            if self.ingest_url:
                try:
                    self.process_pending_once()
                except Exception as e:
                    logger.error("Unexpected error in OutboxSender loop: %s", e, exc_info=True)
            self._stop_event.wait(self._current_backoff)
