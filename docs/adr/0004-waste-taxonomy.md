# ADR 0004: Canonical Waste Taxonomy, COCO Mapping, and Unit Float Confidence

## Status
Accepted

## Context
Prior to Phase 1/2:
- The YOLO model deployed (`yolo26n.pt`) is an 80-class COCO base model (detects `bottle`, `cup`, `banana`, etc.).
- The system falsely claimed to detect non-COCO materials such as `plastic`, `paper`, `glass`, `metal`, `cardboard`, and `cans`.
- Taxonomy labels diverged between repositories (snake_case vs Title Case vs COCO).
- Confidence values were inconsistent: Detection returned 0–100 percentage values, while standard ML schemas expect floats in the `[0.0, 1.0]` range.

## Decision
1. **Single Source of Truth**: We establish `contracts/taxonomy.yaml` as the canonical taxonomy registry across both repositories.
2. **COCO Mapping**: The detector uses `classification_method: "coco_mapping"` and `taxonomy_version: "1.0.0"`. Only the 18 mapped COCO labels produce waste detection items. Non-waste COCO classes (e.g. `person`, `car`, `dog`) and unmapped labels are strictly filtered out and never reported as waste.
3. **Property Enums**: Recyclable and biodegradable attributes are restricted to standard enum values: `"yes"`, `"no"`, `"estimated"`, `"depends"`, or `"unknown"`. Material is marked `"unknown"` unless determined by an authenticated model.
4. **Unit Float Confidence**: All confidence values across internal detector representations, JSON payloads, settings endpoints, and public APIs are normalized to `float` in the range `[0.0, 1.0]`. Percentage values (e.g. `50`) are rejected with HTTP 400 Bad Request. Client UIs are updated to format percentages strictly at display time.

## Consequences
- **Positive**: Truthful AI capabilities; prevents false claims regarding material classification; consistent contract between sensor and Command Center; full CI schema validation in both repos.
- **Negative**: Breaking API contract change for clients expecting 0-100 percentages; documented in `docs/CONTRACT.md` with migration notes.
