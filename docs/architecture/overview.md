# EcoWing Architecture Overview

## Monorepo Architecture

EcoWing coordinates autonomous aerial drone surveillance with edge/ground-based computer vision sensors to monitor and classify ecological waste.

```
                    +---------------------------+
                    |   contracts/              |
                    |   - taxonomy.yaml         |
                    |   - schemas/              |
                    +-------------+-------------+
                                  |
              +-------------------+-------------------+
              |                                       |
              v                                       v
+-----------------------------+       +-----------------------------+
| services/sensor/            |       | services/command-center/    |
| - FastAPI HTTP/WS engine    | ----> | - Express API server        |
| - YOLOv8 inference          | (push)| - Drone telemetry state     |
| - SQLite transactional outbox       | - Ingestion validator       |
+-----------------------------+       +-----------------------------+
              ^                                       |
              |                                       v
+-----------------------------+       +-----------------------------+
| Mobile streaming client     |       | dashboard/ (Operator Web)   |
| (Pairing code handshake)    |       | Leaflet GIS & Socket.IO     |
+-----------------------------+       +-----------------------------+
```
