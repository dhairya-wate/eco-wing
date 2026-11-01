#!/usr/bin/env python3
"""
Contract and Schema Validation Tool
Validates canonical taxonomy and JSON schemas in contracts/
"""
import sys
import json
from pathlib import Path
import yaml
import jsonschema

def validate_contracts():
    root = Path(__file__).resolve().parent.parent
    contracts_dir = root / "contracts"

    taxonomy_file = contracts_dir / "taxonomy.yaml"
    schemas_dir = contracts_dir / "schemas"

    print(f"Validating taxonomy at: {taxonomy_file}")
    if not taxonomy_file.exists():
        print("ERROR: taxonomy.yaml not found!")
        return 1

    with open(taxonomy_file, "r", encoding="utf-8") as f:
        tax = yaml.safe_load(f)

    assert "taxonomy_version" in tax, "Missing taxonomy_version"
    assert "classes" in tax, "Missing classes"
    assert len(tax["classes"]) == 18, f"Expected 18 classes, got {len(tax['classes'])}"
    print(f"Taxonomy OK ({len(tax['classes'])} classes)")

    print(f"Validating schemas in: {schemas_dir}")
    for sfile in schemas_dir.glob("*.json"):
        with open(sfile, "r", encoding="utf-8") as f:
            schema = json.load(f)
        jsonschema.Draft7Validator.check_schema(schema)
        print(f"Schema OK: {sfile.name}")

    print("All contracts valid.")
    return 0

if __name__ == "__main__":
    sys.exit(validate_contracts())
