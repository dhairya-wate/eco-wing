# Contributing to EcoWing

Thank you for contributing to EcoWing. This repository is structured as a unified monorepo.

## Monorepo Layout

- `contracts/`: Single source of truth for taxonomy and schemas (`taxonomy.yaml`, `schemas/`).
- `services/command-center/`: Node.js Express backend and operator services.
- `services/sensor/`: Python FastAPI waste detection and telemetry sensor service.
- `dashboard/`: Operator web console.
- `deploy/`: Deployment manifests (Docker Compose, Nginx, environment configs).
- `models/`: ML weights and model fetch utilities.
- `tools/`: Contract validators and developer utilities.
- `docs/`: Architecture decision records (ADRs), specifications, and runbooks.

## Ground Rules

1. **Contract Integrity**: All schema and taxonomy modifications must originate in `contracts/`. Do not duplicate contract definitions in services.
2. **Deterministic Changes**: Maintain strict test pass parity across all runners (`node --test`, `pytest`).
3. **Line Endings**: Enforce LF line endings for all text files via `.gitattributes`.
4. **Security**: Validate all inputs at network trust boundaries. Never disable auth or CORS protections.

## Running Tests

- **Command Center Node Suite**:
  ```bash
  cd services/command-center/backend
  npm test
  ```
- **Command Center Python Integration Suite**:
  ```bash
  cd services/command-center
  pytest -v
  ```
- **Sensor Python Suite**:
  ```bash
  cd services/sensor
  pytest -v
  ```
