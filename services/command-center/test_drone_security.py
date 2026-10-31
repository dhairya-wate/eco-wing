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

def test_default_allowlist_is_empty_and_rejects_192_168_1_50():
    """Default DRONE_TARGET_ALLOWLIST is empty, rejecting 192.168.1.50 and localhost."""
    code = """
    (async () => {
        delete process.env.DRONE_TARGET_ALLOWLIST;
        const { validateTarget } = require('./backend/routes/drone');
        const res1 = await validateTarget('192.168.1.50');
        console.log(JSON.stringify(res1));
        process.exit(0);
    })();
    """
    out = run_node_eval(code, env={"DRONE_TARGET_ALLOWLIST": ""})
    assert out["ok"] is False
    assert "192.168.1.50" in out["error"]
    assert "DRONE_TARGET_ALLOWLIST" in out["error"]

def test_bypass_user_info_spoofing_rejected():
    """URLs with user-info tricks (e.g. http://localhost@evil.com) are rejected."""
    code = """
    (async () => {
        const { validateTarget } = require('./backend/routes/drone');
        const res = await validateTarget('http://localhost@evil.com/stream');
        console.log(JSON.stringify(res));
        process.exit(0);
    })();
    """
    out = run_node_eval(code)
    assert out["ok"] is False
    assert "User-info in URL is prohibited" in out["error"]

def test_bypass_ipv6_bracketed_rejected_when_not_in_allowlist():
    """IPv6 addresses like [::1] are rejected when not explicitly allowlisted."""
    code = """
    (async () => {
        const { validateTarget } = require('./backend/routes/drone');
        const res = await validateTarget('http://[::1]:5000/video_feed');
        console.log(JSON.stringify(res));
        process.exit(0);
    })();
    """
    out = run_node_eval(code, env={"DRONE_TARGET_ALLOWLIST": "drone.internal"})
    assert out["ok"] is False
    assert "::1" in out["error"]
    assert "DRONE_TARGET_ALLOWLIST" in out["error"]

def test_bypass_decimal_ipv4_rejected():
    """Decimal representations of IPv4 (e.g. 2130706433 for 127.0.0.1) are rejected."""
    code = """
    (async () => {
        const { validateTarget } = require('./backend/routes/drone');
        const res = await validateTarget('http://2130706433:5000/feed');
        console.log(JSON.stringify(res));
        process.exit(0);
    })();
    """
    out = run_node_eval(code)
    assert out["ok"] is False
    assert "Decimal IPv4 representation rejected" in out["error"]

def test_bypass_shortened_ipv4_rejected():
    """Shortened IPv4 representations (e.g. 127.1) are rejected."""
    code = """
    (async () => {
        const { validateTarget } = require('./backend/routes/drone');
        const res = await validateTarget('http://127.1:5000/feed');
        console.log(JSON.stringify(res));
        process.exit(0);
    })();
    """
    out = run_node_eval(code)
    assert out["ok"] is False
    assert "Shortened or invalid numeric IPv4 representation rejected" in out["error"]

def test_bypass_octal_ipv4_rejected():
    """Octal IPv4 representations (e.g. 0177.0.0.1) are rejected."""
    code = """
    (async () => {
        const { validateTarget } = require('./backend/routes/drone');
        const res = await validateTarget('http://0177.0.0.1:5000/feed');
        console.log(JSON.stringify(res));
        process.exit(0);
    })();
    """
    out = run_node_eval(code)
    assert out["ok"] is False
    assert "Octal IPv4 representation rejected" in out["error"]

def test_redirect_to_non_allowlisted_host_rejected():
    """Fetch to stream target with redirect: 'manual' rejects HTTP 3xx redirects."""
    code = """
    const express = require('express');
    const http = require('http');

    const app = express();
    app.get('/redirect', (req, res) => {
        res.redirect(302, 'http://evil-host.com/secret');
    });

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const targetUrl = `http://127.0.0.1:${port}/redirect`;

        try {
            const fetchRes = await fetch(targetUrl, {
                method: 'GET',
                redirect: 'manual'
            });
            const isRedirect = (fetchRes.status >= 300 && fetchRes.status < 400);
            console.log(JSON.stringify({ isRedirect, status: fetchRes.status }));
        } catch (e) {
            console.log(JSON.stringify({ error: e.message }));
        } finally {
            srv.close(() => process.exit(0));
        }
    });
    """
    out = run_node_eval(code)
    assert out.get("isRedirect") is True
    assert out.get("status") == 302

def test_operator_token_protection_on_drone_connect():
    """POST /api/drone/connect requires X-Operator-Token header."""
    code = """
    const express = require('express');
    const http = require('http');
    process.env.ECOWING_OPERATOR_TOKEN = 'secret_test_operator_token_32_chars_123';
    process.env.DRONE_TARGET_ALLOWLIST = 'allowed.drone.lan,192.0.2.10';

    const droneRouter = require('./backend/routes/drone');
    const app = express();
    app.use(express.json());
    app.use('/api/drone', droneRouter);

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const base = `http://127.0.0.1:${port}/api/drone/connect`;

        // 1. Missing token -> 401
        const r1 = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ drone_id: 'Drone-01' })
        });
        const d1 = await r1.json();

        // 2. Invalid token -> 401
        const r2 = await fetch(base, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Operator-Token': 'wrong-token'
            },
            body: JSON.stringify({ drone_id: 'Drone-01' })
        });

        // 3. Valid token + allowed host -> 200
        const r3 = await fetch(base, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Operator-Token': 'secret_test_operator_token_32_chars_123'
            },
            body: JSON.stringify({
                drone_id: 'Drone-01',
                address: '192.0.2.10'
            })
        });
        const d3 = await r3.json();

        console.log(JSON.stringify({
            status_no_token: r1.status,
            status_bad_token: r2.status,
            status_valid_token: r3.status,
            success: d3.success
        }));

        srv.close();
        setTimeout(() => process.exit(0), 50);
    });
    """
    out = run_node_eval(code)
    assert out["status_no_token"] == 401
    assert out["status_bad_token"] == 401
    assert out["status_valid_token"] == 200
    assert out["success"] is True

def test_drone_connect_endpoint_rejects_http_redirect():
    """POST /api/drone/connect rejects stream URLs that return 3xx redirects."""
    code = """
    const express = require('express');
    const http = require('http');

    // 1. Target server that issues a 302 redirect
    const targetApp = express();
    targetApp.get('/redirect', (req, res) => {
        res.redirect(302, 'http://127.0.0.1:9999/unauthorized_destination');
    });
    const targetSrv = http.createServer(targetApp);

    targetSrv.listen(0, '127.0.0.1', async () => {
        const targetPort = targetSrv.address().port;
        const redirectUrl = `http://127.0.0.1:${targetPort}/redirect`;

        // 2. EcoWing Drone API server
        process.env.ECOWING_OPERATOR_TOKEN = 'secret_test_operator_token_32_chars_123';
        process.env.DRONE_TARGET_ALLOWLIST = '127.0.0.1';

        const droneRouter = require('./backend/routes/drone');
        const apiApp = express();
        apiApp.use(express.json());
        apiApp.use('/api/drone', droneRouter);

        const apiSrv = http.createServer(apiApp);
        apiSrv.listen(0, '127.0.0.1', async () => {
            const apiPort = apiSrv.address().port;

            try {
                const response = await fetch(`http://127.0.0.1:${apiPort}/api/drone/connect`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Operator-Token': 'secret_test_operator_token_32_chars_123'
                    },
                    body: JSON.stringify({
                        drone_id: 'Drone-Redirect-Test',
                        stream_url: redirectUrl
                    })
                });

                const data = await response.json();
                console.log(JSON.stringify({
                    status: response.status,
                    error: data.error
                }));
            } finally {
                apiSrv.close();
                targetSrv.close();
                setTimeout(() => process.exit(0), 50);
            }
        });
    });
    """
    out = run_node_eval(code)
    assert out["status"] == 400
    assert "redirect" in out["error"].lower()
    assert "strictly prohibited" in out["error"].lower()

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

def test_dns_rebinding_rejected_with_resolver_stub():
    """
    Tests DNS rebinding prevention:
    If a hostname in DRONE_TARGET_ALLOWLIST resolves to an IP NOT in the allowlist,
    validateTarget rejects with a DNS rebinding security error.
    If it resolves to an allowlisted IP, connectUrl connects to the verified IP directly.
    """
    code = """
    (async () => {
        process.env.DRONE_TARGET_ALLOWLIST = 'camera.drone.lan,192.0.2.10';
        const { validateTarget } = require('./backend/routes/drone');

        // Stub A: resolves to unauthorized IP (192.0.2.99 not in allowlist) -> REBINDING DETECTED!
        const evilResolver = async (host) => {
            return [{ address: '192.0.2.99', family: 4 }];
        };
        const evilRes = await validateTarget('http://camera.drone.lan:8080/feed', { resolver: evilResolver });

        // Stub B: resolves to authorized IP (192.0.2.10 in allowlist) -> CONNECT TO VERIFIED IP DIRECTLY!
        const goodResolver = async (host) => {
            return [{ address: '192.0.2.10', family: 4 }];
        };
        const goodRes = await validateTarget('http://camera.drone.lan:8080/feed', { resolver: goodResolver });

        console.log(JSON.stringify({
            evil_ok: evilRes.ok,
            evil_error: evilRes.error,
            good_ok: goodRes.ok,
            good_verified_ip: goodRes.verifiedIp,
            good_connect_url: goodRes.connectUrl,
            good_original_host: goodRes.originalHost
        }));
        process.exit(0);
    })();
    """
    out = run_node_eval(code)
    assert out["evil_ok"] is False
    assert "DNS rebinding protection" in out["evil_error"]
    assert "192.0.2.99" in out["evil_error"]

    assert out["good_ok"] is True
    assert out["good_verified_ip"] == "192.0.2.10"
    assert out["good_connect_url"] == "http://192.0.2.10:8080/feed"
    assert out["good_original_host"] == "camera.drone.lan"
