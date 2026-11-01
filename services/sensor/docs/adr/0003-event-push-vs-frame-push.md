# ADR 0003: Edge Detection Event Push vs. Centralized Frame Push Ingestion

## Status
Accepted

## Context
Two architectural options exist for processing computer vision in a drone fleet:
1. **Centralized Frame Streaming (Frame Push)**: Drones continuously stream raw video frames (or JPEG snapshots) over wireless telemetry links (cellular/Wi-Fi) to the central EcoWing backend, which runs YOLO inference centrally.
2. **Edge Processing with Structured Event Push (Event Push)**: The drone companion computer (running the Detection worker) performs local YOLO inference on raw camera frames on edge hardware, identifies waste items, and pushes lightweight JSON telemetry events (`/api/drone/detection`) containing bounding boxes and classifications.

Constraints:
- Drone wireless links (4G/5G, point-to-point Wi-Fi) frequently suffer from packet loss, jitter, latency spikes, and severe bandwidth constraints.
- Streaming 30 FPS HD video continuously from multiple drones to a central server saturates network uplinks and degrades critical telemetry and flight safety control channels.
- Server-side inference scales poorly with fleet size, requiring expensive GPU infrastructure at the Command Center.

## Decision
We adopt **Edge Processing with Structured Detection Event Push**:
1. Detection runs YOLO inference locally on the drone / sensor node in a dedicated background worker (`worker.py`).
2. Mapped waste detections are formatted into canonical JSON events conforming to `contracts/detection-event.schema.json`.
3. An asynchronous SQLite outbox queue (`outbox.py`) queues events locally on disk.
4. An `OutboxSender` pushes structured events to EcoWing's `/api/drone/detection` with `X-Drone-Token` and `X-Drone-Id`.
5. If the wireless link drops, the drone retains events in local SQLite storage with exponential backoff. Upon reconnection, pending events are uploaded in-order without data loss.
6. The MJPEG video stream remains available for live pilot visual inspection over Nginx on-demand, but is independent of analytics ingestion.

## Consequences
- **Positive**: Resilient to intermittent wireless dropouts; minimal network bandwidth consumption (~1 KB per detection event vs ~5 MB/s video); avoids GPU scaling bottlenecks at the Command Center.
- **Negative**: Drone companion computer must have sufficient edge computing capability (e.g. Raspberry Pi 5, Jetson Orin Nano, or mobile device).
