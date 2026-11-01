import os
import sys
from pathlib import Path
import pytest

src_path = str(Path(__file__).resolve().parent.parent / "src" / "ecowing_sensor")
if src_path not in sys.path:
    sys.path.insert(0, src_path)

current_pp = os.environ.get("PYTHONPATH", "")
if src_path not in current_pp:
    os.environ["PYTHONPATH"] = f"{src_path}{os.pathsep}{current_pp}" if current_pp else src_path

TEST_OPERATOR_TOKEN = "secure_test_operator_token_9xK2mP7qR4vL8wZ1" # High-entropy token
os.environ["DETECTION_OPERATOR_TOKEN"] = TEST_OPERATOR_TOKEN
os.environ["MOBILE_ENABLED"] = "true"
os.environ["MAX_UPLOAD_SIZE_BYTES"] = str(5 * 1024 * 1024)
os.environ["ALLOW_LAN"] = "false"

@pytest.fixture(scope="session")
def operator_token():
    return TEST_OPERATOR_TOKEN

