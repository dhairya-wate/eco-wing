import json
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
        Path(__file__).resolve().parents[4] / "contracts",
        Path(__file__).resolve().parents[2] / "contracts",
        Path(__file__).resolve().parents[3] / "contracts",
        Path(__file__).resolve().parent.parent / "contracts",
    ]
    contracts_dir = None
    for cand in candidates:
        if (cand / "taxonomy.yaml").exists() and (
            (cand / "schemas" / "detection-event.schema.json").exists()
            or (cand / "detection-event.schema.json").exists()
        ):
            contracts_dir = cand
            break

    assert contracts_dir is not None, f"Could not find contracts directory among candidates: {candidates}"
    taxonomy_file = contracts_dir / "taxonomy.yaml"
    schema_file = (
        contracts_dir / "schemas" / "detection-event.schema.json"
        if (contracts_dir / "schemas" / "detection-event.schema.json").exists()
        else contracts_dir / "detection-event.schema.json"
    )

    assert taxonomy_file.exists(), f"Taxonomy file {taxonomy_file} does not exist"
    assert schema_file.exists(), f"Schema file {schema_file} does not exist"

    with open(taxonomy_file, "r", encoding="utf-8") as f:
        tax = yaml.safe_load(f)

    with open(schema_file, "r", encoding="utf-8") as f:
        det_schema = json.load(f)

    # 1. Validate taxonomy classes
    allowed_materials = set(tax["allowed_property_values"]["material"])
    allowed_rec = set(tax["allowed_property_values"]["recyclable"])
    allowed_bio = set(tax["allowed_property_values"]["biodegradable"])

    assert tax["taxonomy_version"] == "1.0.0"
    assert tax["classification_method"] == "coco_mapping"
    assert len(tax["classes"]) == 18

    for cid, cinfo in tax["classes"].items():
        assert cid == cinfo["class_id"]
        assert cid.islower() and " " not in cid
        assert cinfo["material"] in allowed_materials
        assert cinfo["recyclable"] in allowed_rec
        assert cinfo["biodegradable"] in allowed_bio

    # 2. Check draft-07 schema validity
    jsonschema.Draft7Validator.check_schema(det_schema)

    # 3. Create valid fixture representing detector output
    valid_event = {
        "event_id": "12345678-1234-4234-8234-123456789abc",
        "drone_id": "Drone-01",
        "source": "camera",
        "observed_at": "2026-11-01T09:20:00Z",
        "taxonomy_version": "1.0.0",
        "classification_method": "coco_mapping",
        "items": [
            {
                "class_id": "bottle",
                "coco_label": "bottle",
                "confidence": 0.85,
                "bbox": [10.0, 15.0, 120.0, 240.0],
                "category": "Container",
                "material": "unknown",
                "recyclable": "depends",
                "biodegradable": "no"
            }
        ]
    }
    jsonschema.validate(instance=valid_event, schema=det_schema)

    # 4. Payload with confidence 50 must fail schema validation
    bad_conf = dict(valid_event)
    bad_conf["items"] = [dict(valid_event["items"][0], confidence=50)]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad_conf, schema=det_schema)

    # 5. Payload with unknown class_id must fail schema validation
    bad_class = dict(valid_event)
    bad_class["items"] = [dict(valid_event["items"][0], class_id="plastic_bag_unknown")]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad_class, schema=det_schema)
