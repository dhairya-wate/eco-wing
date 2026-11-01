import os
import pytest

TEST_OPERATOR_TOKEN = "secure_test_operator_token_9xK2mP7qR4vL8wZ1" # High-entropy token
os.environ["DETECTION_OPERATOR_TOKEN"] = TEST_OPERATOR_TOKEN
os.environ["MOBILE_ENABLED"] = "true"
os.environ["MAX_UPLOAD_SIZE_BYTES"] = str(5 * 1024 * 1024)
os.environ["ALLOW_LAN"] = "false"

@pytest.fixture(scope="session")
def operator_token():
    return TEST_OPERATOR_TOKEN

