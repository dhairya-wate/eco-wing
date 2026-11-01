import pytest
import numpy as np
from ultralytics import YOLO

import config
from config import (
    COCO_WASTE_MAPPING,
    ALLOWED_CLASSIFICATION_VALUES,
    TAXONOMY_VERSION,
    CLASSIFICATION_METHOD,
    resolve_waste_item,
    MODEL_PATH
)
from detector import WasteDetector


def test_every_mapping_coco_label_exists_in_model_classes():
    """Every entry in COCO_WASTE_MAPPING must match an authentic class in the YOLO model."""
    detector = WasteDetector()
    model_classes = set(detector.model.names.values())

    for coco_label, entry in COCO_WASTE_MAPPING.items():
        assert coco_label in model_classes, f"Mapping label '{coco_label}' not found in YOLO model classes!"
        assert entry["coco_label"] == coco_label
        assert entry["model_supported"] is True
        assert entry["classification_method"] == "coco_mapping"
        assert entry["material"] == "unknown"


def test_recyclable_and_biodegradable_allowed_enum_values():
    """All recyclable and biodegradable properties must strictly use allowed enum values."""
    for label, entry in COCO_WASTE_MAPPING.items():
        rec = entry.get("recyclable")
        bio = entry.get("biodegradable")
        assert rec in ALLOWED_CLASSIFICATION_VALUES, (
            f"Invalid recyclable value '{rec}' for '{label}'. Allowed: {ALLOWED_CLASSIFICATION_VALUES}"
        )
        assert bio in ALLOWED_CLASSIFICATION_VALUES, (
            f"Invalid biodegradable value '{bio}' for '{label}'. Allowed: {ALLOWED_CLASSIFICATION_VALUES}"
        )


def test_unmapped_coco_labels_produce_no_waste_items():
    """
    Unmapped COCO labels (e.g. person, car, dog, airplane) must return None
    from resolve_waste_item and must produce no waste detections.
    Also verifies the system does not claim the model detects unmapped materials
    like paper, glass, cans, or plastic directly.
    """
    unmapped_labels = [
        "person", "car", "dog", "airplane", "bicycle", "chair", "sofa",
        # Non-COCO raw material labels that the model does not directly detect:
        "paper", "glass", "can", "cans", "plastic", "metal", "cardboard", "trash"
    ]
    for label in unmapped_labels:
        assert resolve_waste_item(label) is None, f"Expected unmapped label '{label}' to resolve to None"


def test_waste_detector_summary_contains_taxonomy_and_method():
    """WasteDetector output summary includes taxonomy_version and classification_method."""
    detector = WasteDetector()
    blank_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    _, summary = detector.detect(blank_frame, draw_overlay=False)

    assert summary["taxonomy_version"] == TAXONOMY_VERSION
    assert summary["classification_method"] == CLASSIFICATION_METHOD
    assert summary["total_count"] == 0
    assert summary["items"] == []
