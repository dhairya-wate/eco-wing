#!/usr/bin/env python3
"""
Model Fetch and Verification Tool
Verifies SHA-256 checksum and provenance of yolo26n.pt
"""
import sys
import hashlib
from pathlib import Path

EXPECTED_SHA256 = "9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef"
EXPECTED_SIZE = 5544453

def verify_model(model_path: Path) -> bool:
    if not model_path.exists():
        print(f"Model file not found: {model_path}")
        return False
    size = model_path.stat().st_size
    if size != EXPECTED_SIZE:
        print(f"Size mismatch: expected {EXPECTED_SIZE}, got {size}")
        return False
    h = hashlib.sha256()
    with open(model_path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    actual_sha = h.hexdigest()
    if actual_sha != EXPECTED_SHA256:
        print(f"SHA-256 mismatch: expected {EXPECTED_SHA256}, got {actual_sha}")
        return False
    print(f"Model verified: {model_path.name} (SHA-256: {actual_sha[:16]}...)")
    return True

if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    candidates = [
        root / "models" / "yolo26n.pt",
        root / "services" / "sensor" / "yolo26n.pt",
    ]
    verified = False
    for cand in candidates:
        if cand.exists():
            verified = verify_model(cand)
            if verified:
                break
    if not verified:
        print("Model verification failed.")
        sys.exit(1)
