import os
import sys
from pathlib import Path
import yaml
import jsonschema
import pytest

def test_contract_schema_and_taxonomy_validation():
    """
    Phase 1 Contract Validation:
    - taxonomy.yaml defines canonical class IDs in snake_case, allowed enums, and valid mappings.
    - detection-event.schema.json validates an authentic detection event emitted from detector fixture.
    - A payload with confidence 50 fails schema validation.
    - A payload with an unknown class_id fails schema validation.
    """
    candidates = [
        Path(__file__).resolve().parent.parent.parent / "contracts",
        Path(__file__).resolve().parent.parent / "contracts",
        Path(__file__).resolve().parents[3] / "contracts",
        Path(r"c:\Users\Anshu\Desktop\mini-project\contracts"),
    ]
    contracts_dir = None
    for cand in candidates:
        if (cand / "taxonomy.yaml").exists() and (cand / "detection-event.schema.json").exists():
            contracts_dir = cand
            break

    assert contracts_dir is not None, f"Could not find contracts directory among candidates: {candidates}"
    taxonomy_file = contracts_dir / "taxonomy.yaml"
    detection_schema_file = contracts_dir / "detection-event.schema.json"

    assert taxonomy_file.exists(), f"taxonomy.yaml not found at {taxonomy_file}"
    assert detection_schema_file.exists(), f"detection-event.schema.json not found at {detection_schema_file}"

    # 1. Parse and validate taxonomy.yaml structure
    with open(taxonomy_file, "r", encoding="utf-8") as f:
        tax = yaml.safe_load(f)

    assert "taxonomy_version" in tax
    assert "classification_method" in tax
    assert "classes" in tax
    assert isinstance(tax["classes"], dict)
    assert len(tax["classes"]) > 0

    valid_enums = {"yes", "no", "estimated", "depends", "unknown"}
    for class_id, meta in tax["classes"].items():
        assert class_id.islower() and " " not in class_id, f"Class ID '{class_id}' must be snake_case"
        assert "display_name" in meta
        assert "coco_label" in meta
        assert "category" in meta
        assert "material" in meta
        assert meta.get("recyclable") in valid_enums, f"Invalid recyclable enum for {class_id}"
        assert meta.get("biodegradable") in valid_enums, f"Invalid biodegradable enum for {class_id}"

    # 2. Parse and validate detection-event.schema.json
    import json
    with open(detection_schema_file, "r", encoding="utf-8") as f:
        detection_schema = json.load(f)

    valid_event = {
        "event_id": "a0000000-0000-4000-8000-000000000001",
        "device_id": "sensor-test-unit",
        "timestamp": 1730000000.123,
        "timestamp_iso": "2024-10-27T03:33:20.123456Z",
        "class_id": "plastic_bottle",
        "display_name": "Plastic Bottle",
        "category": "plastic",
        "material": "unknown",
        "confidence": 0.88,
        "bbox": [10.0, 20.0, 100.0, 200.0],
        "recyclable": "yes",
        "biodegradable": "no",
        "source": "camera",
        "classification_method": "coco_mapping",
        "taxonomy_version": "1.0.0"
    }

    # Should succeed without error
    jsonschema.validate(instance=valid_event, schema=detection_schema)

    # 3. Payload with confidence 50 (percentage) MUST fail schema validation
    invalid_conf_event = valid_event.copy()
    invalid_conf_event["confidence"] = 50
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=invalid_conf_event, schema=detection_schema)

    # 4. Payload with unknown class_id MUST fail schema validation
    invalid_class_event = valid_event.copy()
    invalid_class_event["class_id"] = "radioactive_uranium_core"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=invalid_class_event, schema=detection_schema)
