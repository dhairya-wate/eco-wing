# Changelog

All notable changes to the EcoWing system are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Unified monorepo structure combining `EcoWing` (Node command center) and `detction system` (Python sensor) into `ecowing/`.
- Root governance and configuration: `.editorconfig`, `.gitattributes` (enforcing LF line endings), `.gitignore`, `.pre-commit-config.yaml`, `SECURITY.md`, `CONTRIBUTING.md`.
- Canonical contracts directory at repository root:
  - `contracts/taxonomy.yaml` (canonical waste taxonomy and class mappings)
  - `contracts/schemas/detection-event.schema.json` (Phase 1 detection event schema)
  - `contracts/schemas/command.schema.json` (drone command state machine schema)
- Relocated test suites:
  - `services/command-center/backend/test/` split into `unit/`, `integration/`, `contract/`
  - `services/sensor/tests/` split into `unit/`, `integration/`, `contract/`

### Changed
- Relocated services to dedicated monorepo paths matching target canonical tree:
  - EcoWing backend restructured to `services/command-center/` (`src/`, `test/`, `package.json`, `package-lock.json`, `Dockerfile`, `.env.example`).
  - Detection sensor restructured to `services/sensor/` (`src/ecowing_sensor/`, `tests/`, `pyproject.toml`, `requirements.lock`, `Dockerfile`, `.env.example`).
- Relocated Docker Compose orchestrator to root `docker-compose.yml`.
- Relocated model assets to root `models/` (`yolo26n.pt`, `README.md`).
- Added root utility scripts in `tools/` (`validate_contracts.py`, `fetch_model.py`).
- Flattened and organized architecture docs in `docs/` (`architecture.md`, `operations.md`, `open-items.md`, `CONTRACT.md`, `adr/`).
- Moved deployment configuration to `deploy/nginx/` (`nginx.conf`).
- Consolidated dashboard entry point in `dashboard/index.html`.
- Updated test runners to resolve contracts from root `contracts/` directory.
- Relocated `api/index.js` (Vercel entrypoint) to `demo/index.js` with static preview README.

### Removed
- Removed root `LICENSE` file from the tree (recorded per Step 1c instruction; no license added).
- Removed developer tunnel script `start_tunnel.bat` (dev-only tunnel).
- Removed redundant contract duplicates from `services/command-center/contracts/` and `services/sensor/contracts/` in favor of single source of truth at root `contracts/`.
