import os
import sys
import subprocess
from pathlib import Path
import pytest

def test_startup_fails_without_operator_token():
    """Server fails fast on startup if DETECTION_OPERATOR_TOKEN is unset."""
    env = os.environ.copy()
    env.pop("DETECTION_OPERATOR_TOKEN", None)
    proc = subprocess.run(
        [sys.executable, "-c", "import config"],
        env=env,
        capture_output=True,
        text=True
    )
    assert proc.returncode != 0
    assert "CRITICAL SECURITY CONFIGURATION ERROR: DETECTION_OPERATOR_TOKEN is unset" in proc.stderr

def test_startup_fails_with_short_operator_token():
    """Server fails fast on startup if DETECTION_OPERATOR_TOKEN is shorter than 32 characters."""
    env = os.environ.copy()
    env["DETECTION_OPERATOR_TOKEN"] = "short-token-12345"
    proc = subprocess.run(
        [sys.executable, "-c", "import config"],
        env=env,
        capture_output=True,
        text=True
    )
    assert proc.returncode != 0
    assert "must be at least 32 characters long" in proc.stderr

def test_startup_fails_with_36_char_repeated_pattern_token():
    """DETECTION_OPERATOR_TOKEN with a 36-character repeated periodic pattern fails startup."""
    env = os.environ.copy()
    env["DETECTION_OPERATOR_TOKEN"] = "abcd" * 9
    proc = subprocess.run(
        [sys.executable, "-c", "import config"],
        env=env,
        capture_output=True,
        text=True
    )
    assert proc.returncode != 0
    assert "repeated pattern" in proc.stderr

def test_fixture_files_exist_on_disk():
    """All 7 image fixtures (PNG, JPG, GIF, BMP, WebP VP8/VP8L/VP8X) exist on disk."""
    fixtures_dir = Path(__file__).resolve().parent / "test_samples" / "fixtures"
    for fname in ["sample.png", "sample.jpg", "sample.gif", "sample.bmp", "sample_vp8.webp", "sample_vp8l.webp", "sample_vp8x.webp"]:
        assert (fixtures_dir / fname).exists(), f"Fixture {fname} missing"
