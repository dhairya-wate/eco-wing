import json
import os
import subprocess
import pytest

ECOWING_DIR = os.path.dirname(os.path.abspath(__file__))

def run_node_eval(code: str, env: dict = None) -> dict:
    """Executes Node snippet and parses JSON output."""
    full_env = os.environ.copy()
    node_modules_path = os.path.join(ECOWING_DIR, "backend", "node_modules")
    full_env["NODE_PATH"] = node_modules_path
    if "ECOWING_OPERATOR_TOKEN" not in full_env:
        full_env["ECOWING_OPERATOR_TOKEN"] = "secure_test_operator_token_9xK2mP7qR4vL8wZ1"
    if env:
        full_env.update(env)
    res = subprocess.run(
        ["node", "-e", code],
        cwd=ECOWING_DIR,
        capture_output=True,
        text=True,
        env=full_env,
        timeout=10
    )
    assert res.returncode == 0, f"Node process failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
    lines = [line.strip() for line in res.stdout.strip().splitlines() if line.strip().startswith("{")]
    assert len(lines) > 0, f"No JSON output from Node snippet:\n{res.stdout}"
    return json.loads(lines[-1])

def test_ecowing_operator_token_startup_validation():
    """Validates that ECOWING_OPERATOR_TOKEN satisfies entropy, length >= 32, and pattern checks."""
    code = """
    const { validateOperatorTokenConfig } = require('./backend/middleware/auth');
    const results = {};

    // 1. Unset/empty token
    try {
        validateOperatorTokenConfig('');
        results.empty = 'FAILED_TO_THROW';
    } catch (e) {
        results.empty = e.message;
    }

    // 2. Short token (< 32 chars)
    try {
        validateOperatorTokenConfig('short_token_12345');
        results.short = 'FAILED_TO_THROW';
    } catch (e) {
        results.short = e.message;
    }

    // 3. Repeated pattern token
    try {
        validateOperatorTokenConfig('abcdef1234567890abcdef1234567890');
        results.pattern = 'FAILED_TO_THROW';
    } catch (e) {
        results.pattern = e.message;
    }

    // 4. Insufficient unique characters (< 12)
    try {
        validateOperatorTokenConfig('01234567890123456789012345678901');
        results.low_variety = 'FAILED_TO_THROW';
    } catch (e) {
        results.low_variety = e.message;
    }

    // 5. Valid token
    try {
        const ok = validateOperatorTokenConfig('secure_test_operator_token_9xK2mP7qR4vL8wZ1');
        results.valid = (ok === 'secure_test_operator_token_9xK2mP7qR4vL8wZ1');
    } catch (e) {
        results.valid = e.message;
    }

    console.log(JSON.stringify(results));
    process.exit(0);
    """
    out = run_node_eval(code)
    assert "is not set" in out["empty"]
    assert "too short" in out["short"]
    assert "repetitive patterns" in out["pattern"]
    assert "insufficient complexity" in out["low_variety"]
    assert out["valid"] is True
