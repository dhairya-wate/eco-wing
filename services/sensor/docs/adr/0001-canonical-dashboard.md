# ADR 0001: Canonical Dashboard Separation and Flight Control Authority

## Status
Accepted

## Context
Prior to Phase 2/3, both repositories contained competing web dashboards:
- `EcoWing/index.html` (Node.js/Socket.IO Command Center with drone flight controls, telemetry gauges, and mission controls).
- `Detection/public/index.html` (FastAPI web interface containing duplicate mock flight controls, simulated drone navigation buttons, and AI waste detection badges).

Having drone flight control capabilities duplicated across both repositories created high operational risk:
1. Operators could issue conflicting flight commands (takeoff, land, RTH) from two disparate web interfaces.
2. The Detection repository lacks drone state machine tracking (FSM), database persistence for drone fleet state, and stale telemetry failsafes.
3. In a real-world multi-drone environment, a physical drone could receive uncoordinated commands causing in-flight collisions or flyaways.

## Decision
We designate **EcoWing** (`c:\Users\Anshu\Desktop\mini-project\EcoWing`) as the sole, authoritative **Fleet Command Center**.
- All physical drone commands (`/api/drone/command`, `/api/camera/command`, `/api/drone/select`) and Socket.IO pilot interfaces reside exclusively in EcoWing.
- All flight controls and drone navigation buttons have been stripped from Detection (`public/index.html` and `templates/index.html`).
- Detection is scoped strictly as an **Edge AI Sensor & Diagnostic Console**. Its web UI serves solely to inspect local camera frames, monitor YOLO model inference, verify waste bounding boxes, and diagnostic latency metrics.

## Consequences
- **Positive**: Single pane of glass for drone pilots; eliminates conflicting command dispatch; enforces operator authentication and FSM safety guards at the Command Center.
- **Negative**: Operators running Detection standalone cannot issue flight commands directly without connecting to the EcoWing Command Center.
