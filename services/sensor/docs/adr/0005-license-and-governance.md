# ADR 0005: License and Open-Source Governance Architecture

## Status
Accepted

## Context
Prior to Phase 6, the repositories lacked formal software licensing:
- `EcoWing` contained no `LICENSE` file.
- `Detection` had an unofficial `package.json` with `"license": "MIT"`, despite being a Python project with third-party model binaries (`yolo26n.pt`) licensed under AGPLv3 (Ultralytics YOLO).
- Deploying proprietary software or physical drone systems without clear licensing exposes contributors and operators to legal ambiguity.

## Decision
1. **EcoWing Command Center License**: We adopt the **MIT License** for the EcoWing Command Center repository (`EcoWing/LICENSE`). The Express, Socket.IO, and dashboard code is open-source under permissive terms.
2. **Detection Licensing Deferred**: The Detection repository uses Ultralytics YOLOv8, which carries AGPLv3 / commercial licensing requirements. Formal standalone open-source licensing for the Detection repo is **deferred** pending organizational review of YOLO model commercial licensing.
3. **Shared Contracts**: The `contracts/` schemas (`detection-event.schema.json`, `command.schema.json`, `taxonomy.yaml`) are published as public domain / permissive schemas to allow interoperability across any drone or sensor hardware.

## Consequences
- **Positive**: Legal clarity for EcoWing Command Center; prevents copyright infringement and unvetted re-licensing of third-party ML binaries.
- **Negative**: Commercial deployments of the Detection repository must comply with Ultralytics AGPLv3 or obtain a commercial enterprise license.
