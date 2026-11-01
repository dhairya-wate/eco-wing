# EcoWing System Monorepo

EcoWing is an autonomous drone-based ecological monitoring and waste detection system.

## Architecture & Layout

```
ecowing/
├── contracts/               # Single source of truth: taxonomy.yaml, schemas/, examples/
│   ├── taxonomy.yaml        # Canonical 18-class waste taxonomy
│   └── schemas/             # JSON schemas (detection-event, command)
├── services/
│   ├── command-center/      # Node.js backend & operator command center
│   └── sensor/              # Python FastAPI sensor service & YOLO model runner
├── dashboard/               # Operator web console
├── deploy/                  # Deployment topologies (Docker Compose, Nginx, env)
├── models/                  # ML model assets and fetch tooling
├── tools/                   # Contract validation and utility tooling
└── docs/                    # Architecture records (ADRs), runbooks, and audit logs
```

## Quick Start & Verification

### Running Test Suites

- **Node.js Command Center Test Suite**:
  ```bash
  cd services/command-center/backend
  npm test
  ```

- **Command Center Integration Security Suite**:
  ```bash
  cd services/command-center
  pytest -v
  ```

- **Python Sensor Test Suite**:
  ```bash
  cd services/sensor
  pytest -v
  ```

## Security & Governance

See [SECURITY.md](SECURITY.md) for vulnerability disclosure protocols.
See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.
