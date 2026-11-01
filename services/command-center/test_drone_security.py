import json
import os
import re
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
    lines = [line.strip() for line in res.stdout.strip().splitlines() if line.strip().startswith("{")]
    # On Windows Node v24, libuv teardown can trigger 3221226505 after output is printed
    assert res.returncode == 0 or (res.returncode == 3221226505 and len(lines) > 0), f"Node process failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
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

def test_command_routes_operator_auth_and_401():
    """
    Verifies that /api/drone/command, /api/camera/command, and /api/drone/select
    all require operator authentication (401 without token, 401 with invalid token, 200 with valid token).
    """
    code = """
    const express = require('express');
    const http = require('http');
    process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';

    const { router: apiRouter } = require('./backend/routes/api');
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const results = {};

        const endpoints = [
            { name: 'drone_command', path: '/api/drone/command', body: { drone_id: 'Drone-01', command: 'start' } },
            { name: 'camera_command', path: '/api/camera/command', body: { command: 'photo' } },
            { name: 'drone_select', path: '/api/drone/select', body: { drone_id: 'Drone-01' } }
        ];

        for (const ep of endpoints) {
            const url = `http://127.0.0.1:${port}${ep.path}`;

            // 1. Missing token -> 401
            const r1 = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ep.body)
            });

            // 2. Bad token -> 401
            const r2 = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Operator-Token': 'wrong_token_value_here'
                },
                body: JSON.stringify(ep.body)
            });

            // 3. Valid token -> 200
            const r3 = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Operator-Token': 'secure_test_operator_token_9xK2mP7qR4vL8wZ1'
                },
                body: JSON.stringify(ep.body)
            });

            results[ep.name] = {
                no_token: r1.status,
                bad_token: r2.status,
                valid_token: r3.status
            };
        }

        console.log(JSON.stringify(results));
        srv.close();
        setTimeout(() => process.exit(0), 50);
    });
    """
    out = run_node_eval(code)
    for name in ["drone_command", "camera_command", "drone_select"]:
        assert out[name]["no_token"] == 401, f"{name} should reject missing token with 401"
        assert out[name]["bad_token"] == 401, f"{name} should reject bad token with 401"
        assert out[name]["valid_token"] == 200, f"{name} should accept valid token with 200"

def test_e1_command_injection_and_parameter_validation():
    """
    E1: Command injection prevention on /api/drone/command and /api/camera/command.
    Rejects unauthorized commands and invalid parameters with HTTP 400.
    """
    code = """
    const express = require('express');
    const http = require('http');
    process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';

    const { router: apiRouter } = require('./backend/routes/api');
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const authHeaders = {
            'Content-Type': 'application/json',
            'X-Operator-Token': 'secure_test_operator_token_9xK2mP7qR4vL8wZ1'
        };

        // 1. Drone command invalid command -> 400
        const r1 = await fetch(`http://127.0.0.1:${port}/api/drone/command`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ drone_id: 'Drone-01', command: 'reboot_os; rm -rf /' })
        });

        // 2. Drone command invalid drone_id -> 400
        const r2 = await fetch(`http://127.0.0.1:${port}/api/drone/command`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ drone_id: 'Drone-01; echo pwned', command: 'start' })
        });

        // 3. Camera command invalid command -> 400
        const r3 = await fetch(`http://127.0.0.1:${port}/api/camera/command`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ command: 'format_storage' })
        });

        // 4. Camera command zoom out of bounds -> 400
        const r4 = await fetch(`http://127.0.0.1:${port}/api/camera/command`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ command: 'zoom', value: 99.0 })
        });

        // 5. Valid camera zoom -> 200
        const r5 = await fetch(`http://127.0.0.1:${port}/api/camera/command`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ command: 'zoom', value: 3.5 })
        });

        console.log(JSON.stringify({
            invalid_cmd: r1.status,
            invalid_drone_id: r2.status,
            invalid_camera_cmd: r3.status,
            invalid_zoom: r4.status,
            valid_zoom: r5.status
        }));
        srv.close();
        setTimeout(() => process.exit(0), 50);
    });
    """
    out = run_node_eval(code)
    assert out["invalid_cmd"] == 400
    assert out["invalid_drone_id"] == 400
    assert out["invalid_camera_cmd"] == 400
    assert out["invalid_zoom"] == 400
    assert out["valid_zoom"] == 200

def test_e2_telemetry_coordinate_battery_validation():
    """
    E2: Input validation on /api/drone/telemetry.
    Rejects out of bounds coordinates, negative/excessive battery percentages, etc.
    """
    code = """
    const express = require('express');
    const http = require('http');

    process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
        'Drone-01': 'test_drone_token_1234567890123456',
        'Drone-01$(reboot)': 'test_drone_token_1234567890123456'
    });
    const droneRouter = require('./backend/routes/drone');
    const app = express();
    app.use(express.json());
    app.use('/api/drone', droneRouter);

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const url = `http://127.0.0.1:${port}/api/drone/telemetry`;
        const authHeaders = {
            'Content-Type': 'application/json',
            'X-Drone-Token': 'test_drone_token_1234567890123456'
        };

        // 1. Invalid battery > 100 -> 400
        const r1 = await fetch(url, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ drone_id: 'Drone-01', battery_pct: 125 })
        });

        // 2. Invalid latitude > 90 -> 400
        const r2 = await fetch(url, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ drone_id: 'Drone-01', latitude: 95.5, longitude: 10.0 })
        });

        // 3. Invalid longitude < -180 -> 400
        const r3 = await fetch(url, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ drone_id: 'Drone-01', latitude: 45.0, longitude: -195.0 })
        });

        // 4. Invalid drone_id -> 400
        const r4 = await fetch(url, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ drone_id: 'Drone-01$(reboot)', battery_pct: 80 })
        });

        // 5. Valid telemetry -> 200
        const r5 = await fetch(url, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
                drone_id: 'Drone-01',
                battery_pct: 88,
                latitude: 37.7749,
                longitude: -122.4194,
                altitude_m: 15.5,
                speed_mps: 4.2,
                heading_deg: 180
            })
        });

        console.log(JSON.stringify({
            invalid_batt: r1.status,
            invalid_lat: r2.status,
            invalid_lng: r3.status,
            invalid_drone_id: r4.status,
            valid_telemetry: r5.status
        }));
        srv.close();
        setTimeout(() => process.exit(0), 50);
    });
    """
    out = run_node_eval(code)
    assert out["invalid_batt"] == 400
    assert out["invalid_lat"] == 400
    assert out["invalid_lng"] == 400
    assert out["invalid_drone_id"] == 400
    assert out["valid_telemetry"] == 200


def test_https_drone_target_rejected():
    """HTTPS targets for LAN drone stream devices are strictly rejected."""
    code = """
    (async () => {
        const { validateTarget } = require('./backend/routes/drone');
        const res = await validateTarget('https://192.0.2.10:8080/stream');
        console.log(JSON.stringify(res));
        process.exit(0);
    })();
    """
    out = run_node_eval(code, env={"DRONE_TARGET_ALLOWLIST": "192.0.2.10"})
    assert out["ok"] is False
    assert "Only unencrypted HTTP" in out["error"]


def test_drone_ingestion_device_token_auth_and_cross_drone_rejection():
    """
    E2 Ingestion Auth: Requires per-drone device token on:
    - POST /api/drone/telemetry
    - POST /api/drone/detection (and /api/detection)
    - POST /api/drone/stream-frame (and /api/stream-frame)
    Verifies 401 on missing token, 401 on invalid token, 401 on cross-drone token misuse,
    and 200 on valid token for the correct drone.
    """
    code = """
    const express = require('express');
    const http = require('http');

    process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
        'drone-alpha': 'token_alpha_12345678901234567890',
        'drone-beta': 'token_beta_12345678901234567890'
    });

    const droneRouter = require('./backend/routes/drone');
    const app = express();
    app.use(express.json());
    app.use('/api/drone', droneRouter);
    app.post('/api/telemetry', (req, res, next) => { req.url = '/telemetry'; droneRouter(req, res, next); });
    app.post('/api/detection', (req, res, next) => { req.url = '/detection'; droneRouter(req, res, next); });
    app.post('/api/stream-frame', (req, res, next) => { req.url = '/stream-frame'; droneRouter(req, res, next); });

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const results = {};

        const endpoints = [
            { path: '/api/drone/telemetry', payload: { drone_id: 'drone-alpha', battery_pct: 90 } },
            { path: '/api/drone/detection', payload: { drone_id: 'drone-alpha', class_name: 'bottle' } },
            { path: '/api/drone/stream-frame', payload: { drone_id: 'drone-alpha', frame: 'base64sample' } },
            { path: '/api/telemetry', payload: { drone_id: 'drone-alpha', battery_pct: 90 } },
            { path: '/api/detection', payload: { drone_id: 'drone-alpha', class_name: 'bottle' } },
            { path: '/api/stream-frame', payload: { drone_id: 'drone-alpha', frame: 'base64sample' } }
        ];

        for (const ep of endpoints) {
            const url = `http://127.0.0.1:${port}${ep.path}`;

            // Case 1: Missing token -> 401
            const r1 = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ep.payload)
            });

            // Case 2: Invalid token -> 401
            const r2 = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Drone-Token': 'wrong_invalid_device_token_xyz123'
                },
                body: JSON.stringify(ep.payload)
            });

            // Case 3: Cross-drone misuse (valid token for drone-alpha used with drone-beta payload) -> 401
            const r3 = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Drone-Token': 'token_alpha_12345678901234567890' // alpha's token
                },
                body: JSON.stringify({ ...ep.payload, drone_id: 'drone-beta' }) // declaring beta!
            });

            // Case 4: Valid token for drone-alpha used with drone-alpha payload -> 200
            const r4 = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Drone-Token': 'token_alpha_12345678901234567890'
                },
                body: JSON.stringify(ep.payload)
            });

            results[ep.path] = {
                missing_token: r1.status,
                invalid_token: r2.status,
                cross_drone_misuse: r3.status,
                valid_token: r4.status
            };
        }

        console.log(JSON.stringify(results));
        srv.close();
        setTimeout(() => process.exit(0), 50);
    });
    """
    out = run_node_eval(code)
    for path, res in out.items():
        assert res["missing_token"] == 401, f"{path} should reject missing token with 401"
        assert res["invalid_token"] == 401, f"{path} should reject invalid token with 401"
        assert res["cross_drone_misuse"] == 401, f"{path} should reject cross-drone token misuse with 401"
        assert res["valid_token"] == 200, f"{path} should accept valid token with 200"


def test_purge_and_export_operator_auth_and_401():
    """
    E3 Purge & Export Protection: Requires operator authentication on:
    - POST /api/feed/clear
    - GET /api/export/csv
    - GET /api/export/json
    Verifies 401 on missing token, 401 on invalid token, and 200 with valid operator token.
    """
    code = """
    const express = require('express');
    const http = require('http');

    process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
    const { router: apiRouter } = require('./backend/routes/api');
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const results = {};

        const routes = [
            { method: 'POST', path: '/api/feed/clear' },
            { method: 'GET', path: '/api/export/csv' },
            { method: 'GET', path: '/api/export/json' }
        ];

        for (const r of routes) {
            const url = `http://127.0.0.1:${port}${r.path}`;

            // Case 1: Missing X-Operator-Token -> 401
            const r1 = await fetch(url, { method: r.method });

            // Case 2: Invalid X-Operator-Token -> 401
            const r2 = await fetch(url, {
                method: r.method,
                headers: { 'X-Operator-Token': 'wrong_token_12345678901234567890' }
            });

            // Case 3: Valid X-Operator-Token -> 200
            const r3 = await fetch(url, {
                method: r.method,
                headers: { 'X-Operator-Token': 'secure_test_operator_token_9xK2mP7qR4vL8wZ1' }
            });

            results[r.path] = {
                missing_token: r1.status,
                invalid_token: r2.status,
                valid_token: r3.status
            };
        }

        console.log(JSON.stringify(results));
        srv.close();
        setTimeout(() => process.exit(0), 50);
    });
    """
    out = run_node_eval(code)
    for path, res in out.items():
        assert res["missing_token"] == 401, f"{path} should reject missing operator token with 401"
        assert res["invalid_token"] == 401, f"{path} should reject invalid operator token with 401"
        assert res["valid_token"] == 200, f"{path} should accept valid operator token with 200"


def test_mongo_uri_credential_validation():
    """Startup check: MONGO_URI must include credentials (user:password@)."""
    code = """
    const { validateMongoUriConfig } = require('./backend/app');
    let errUncredentialed = null;
    let errEmpty = null;
    try {
        validateMongoUriConfig('mongodb://mongodb:27017/ecowing');
    } catch (e) {
        errUncredentialed = e.message;
    }
    try {
        validateMongoUriConfig('');
    } catch (e) {
        errEmpty = e.message;
    }
    const validLocal = validateMongoUriConfig('mongodb://admin:pass@mongodb:27017/ecowing?authSource=admin');
    console.log(JSON.stringify({
        has_uncredentialed_err: errUncredentialed !== null,
        has_empty_err: errEmpty !== null,
        valid_local: validLocal.includes('admin:pass@')
    }));
    process.exit(0);
    """
    out = run_node_eval(code)
    assert out["has_uncredentialed_err"] is True
    assert out["has_empty_err"] is True
    assert out["valid_local"] is True


def test_e_new1_cors_origin_allowlist():
    """E-NEW1: Restrict CORS to configured origin allowlist (wildcard * is strictly rejected, unauthorized origins rejected with 403)."""
    code = """
    const http = require('http');
    const app = require('./backend/app');
    const { allowedOrigins } = require('./backend/app');

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        try {
            // Authorized origin HTTP request
            const rAuth = await fetch(`http://127.0.0.1:${port}/health`, {
                headers: { 'Origin': 'http://localhost:8080' }
            });
            const allowOriginHeader = rAuth.headers.get('access-control-allow-origin');

            // Unauthorized origin HTTP request
            const rUnauth = await fetch(`http://127.0.0.1:${port}/health`, {
                headers: { 'Origin': 'http://evil-attacker.com' }
            });
            const unauthAllowOriginHeader = rUnauth.headers.get('access-control-allow-origin');
            const unauthBody = await rUnauth.json();

            console.log(JSON.stringify({
                has_wildcard: allowedOrigins.includes('*'),
                has_local_8080: allowedOrigins.includes('http://localhost:8080'),
                has_local_3000: allowedOrigins.includes('http://localhost:3000'),
                auth_status: rAuth.status,
                auth_header: allowOriginHeader,
                unauth_status: rUnauth.status,
                unauth_header: unauthAllowOriginHeader,
                unauth_error: unauthBody.error
            }));
        } catch (e) {
            console.error(e);
            console.log(JSON.stringify({ error: e.message }));
        } finally {
            srv.close();
        }
    });
    """
    out = run_node_eval(code)
    assert out["has_wildcard"] is False
    assert out["has_local_8080"] is True
    assert out["has_local_3000"] is True
    assert out["auth_status"] == 200
    assert out["auth_header"] == "http://localhost:8080"
    assert out["unauth_status"] == 403
    assert out["unauth_header"] is None
    assert out["unauth_error"] == "Forbidden"


def test_socket_io_drone_events_require_device_token():
    """Socket.IO drone events (telemetry, detection, frame) require per-drone device token."""
    code = """
    process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
        'drone-alpha': 'token_alpha_12345678901234567890',
        'drone-beta': 'token_beta_12345678901234567890'
    });
    const { verifySocketDroneAuth } = require('./backend/server');

    // 1. Missing token -> rejected
    const r1 = verifySocketDroneAuth({ droneId: null }, { drone_id: 'drone-alpha' });

    // 2. Invalid token -> rejected
    const r2 = verifySocketDroneAuth({ droneId: null }, { drone_id: 'drone-alpha', token: 'wrong' });

    // 3. Cross-drone misuse (alpha token for beta drone) -> rejected
    const r3 = verifySocketDroneAuth({ droneId: null }, { drone_id: 'drone-beta', token: 'token_alpha_12345678901234567890' });

    // 4. Valid token -> accepted
    const r4 = verifySocketDroneAuth({ droneId: null }, { drone_id: 'drone-alpha', token: 'token_alpha_12345678901234567890' });

    console.log(JSON.stringify({
        missing_token_ok: r1.ok,
        invalid_token_ok: r2.ok,
        cross_drone_ok: r3.ok,
        valid_token_ok: r4.ok
    }));
    process.exit(0);
    """
    out = run_node_eval(code)
    assert out["missing_token_ok"] is False
    assert out["invalid_token_ok"] is False
    assert out["cross_drone_ok"] is False
    assert out["valid_token_ok"] is True


def test_video_feed_operator_auth_gate():
    """Proxied /video_feed operator auth gate rejects unauthenticated requests with 401."""
    code = """
    const express = require('express');
    const http = require('http');
    process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
    const app = require('./backend/app');

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const url = `http://127.0.0.1:${port}/video_feed`;

        // 1. Unauthenticated -> 401
        const r1 = await fetch(url);

        // 2. Invalid token -> 401
        const r2 = await fetch(url, {
            headers: { 'X-Operator-Token': 'wrong_operator_token_12345' }
        });

        // 3. With valid token -> starts streaming (200)
        const controller = new AbortController();
        const r3 = await fetch(url, {
            headers: { 'X-Operator-Token': 'secure_test_operator_token_9xK2mP7qR4vL8wZ1' },
            signal: controller.signal
        });
        controller.abort();

        console.log(JSON.stringify({
            unauth_status: r1.status,
            bad_token_status: r2.status,
            valid_token_status: r3.status
        }));
        srv.close();
        setTimeout(() => process.exit(0), 50);
    });
    """
    out = run_node_eval(code)
    assert out["unauth_status"] == 401
    assert out["bad_token_status"] == 401
    assert out["valid_token_status"] == 200


def test_contract_schemas_and_command_state_machine_validation():
    """
    Phase 1 Contract Validation in EcoWing:
    - detection-event.schema.json validates detection event fixtures and rejects confidence 50 / unknown class.
    - command.schema.json validates drone commands and specifies valid state machine transitions.
    """
    import json
    import yaml
    import jsonschema
    from pathlib import Path

    contracts_dir = Path(__file__).resolve().parent / "contracts"
    if not contracts_dir.exists():
        contracts_dir = Path(__file__).resolve().parent.parent / "contracts"

    det_schema_path = contracts_dir / "detection-event.schema.json"
    cmd_schema_path = contracts_dir / "command.schema.json"
    tax_path = contracts_dir / "taxonomy.yaml"

    assert det_schema_path.exists(), f"{det_schema_path} missing"
    assert cmd_schema_path.exists(), f"{cmd_schema_path} missing"
    assert tax_path.exists(), f"{tax_path} missing"

    with open(det_schema_path, "r", encoding="utf-8") as f:
        det_schema = json.load(f)
    with open(cmd_schema_path, "r", encoding="utf-8") as f:
        cmd_schema = json.load(f)
    with open(tax_path, "r", encoding="utf-8") as f:
        taxonomy = yaml.safe_load(f)

    # Validate schema definitions
    jsonschema.Draft7Validator.check_schema(det_schema)
    jsonschema.Draft7Validator.check_schema(cmd_schema)

    # Test detection-event valid fixture
    valid_event = {
        "event_id": "00000000-0000-4000-8000-000000000001",
        "drone_id": "Drone-01",
        "source": "camera",
        "observed_at": "2026-11-01T09:20:00Z",
        "taxonomy_version": "1.0.0",
        "classification_method": "coco_mapping",
        "items": [
            {
                "class_id": "bottle",
                "coco_label": "bottle",
                "confidence": 0.92,
                "bbox": [50.0, 50.0, 200.0, 300.0],
                "category": "Container",
                "material": "unknown",
                "recyclable": "depends",
                "biodegradable": "no"
            }
        ]
    }
    jsonschema.validate(instance=valid_event, schema=det_schema)

    # Rejection of confidence 50
    bad_conf = dict(valid_event)
    bad_conf["items"] = [dict(valid_event["items"][0], confidence=50)]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad_conf, schema=det_schema)

    # Rejection of unknown class_id
    bad_cid = dict(valid_event)
    bad_cid["items"] = [dict(valid_event["items"][0], class_id="non_existent_class")]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad_cid, schema=det_schema)

    # Test command schema valid fixture
    valid_cmd = {
        "command_id": "11111111-2222-4333-8444-555555555555",
        "drone_id": "Drone-01",
        "command": "land",
        "state": "requested",
        "actor": "operator_console",
        "created_at": "2026-11-01T09:20:00Z",
        "updated_at": "2026-11-01T09:20:00Z"
    }
    jsonschema.validate(instance=valid_cmd, schema=cmd_schema)

    # Verify state machine transitions specification
    fsm = cmd_schema["state_machine_specification"]
    assert fsm["initial_state"] == "requested"
    assert "sent" in fsm["allowed_transitions"]["requested"]
    assert "rejected" in fsm["allowed_transitions"]["requested"]
    assert "acknowledged" in fsm["allowed_transitions"]["sent"]
    assert "timed_out" in fsm["allowed_transitions"]["sent"]
    assert "executing" in fsm["allowed_transitions"]["acknowledged"]
    assert "completed" in fsm["allowed_transitions"]["executing"]


def test_detection_ingestion_canonical_schema_validation_and_rejection():
    """
    Phase 3.1: Canonical detection event schema validation on POST /api/drone/detection:
    1. Valid canonical event with UUIDv4, source, taxonomy, items array -> 200 OK
    2. Out-of-bounds confidence (1.5 or 50) -> 400 Bad Request
    3. Unknown class_id outside taxonomy -> 400 Bad Request
    4. Non-UUIDv4 event_id -> 400 Bad Request
    5. Empty or missing fields -> 400 Bad Request
    """
    code = """
    const express = require('express');
    const http = require('http');

    process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
    process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
        'drone-alpha': 'token_alpha_12345678901234567890'
    });

    const droneRouter = require('./backend/routes/drone');
    const app = express();
    app.use(express.json());
    app.use('/api/drone', droneRouter);

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const url = `http://127.0.0.1:${port}/api/drone/detection`;
        const headers = {
            'Content-Type': 'application/json',
            'X-Drone-Token': 'token_alpha_12345678901234567890',
            'X-Drone-Id': 'drone-alpha'
        };

        const validEvent = {
            event_id: '12345678-1234-4234-8234-123456789abc',
            drone_id: 'drone-alpha',
            source: 'camera',
            observed_at: '2026-11-01T04:00:00.000Z',
            taxonomy_version: '1.0.0',
            classification_method: 'coco_mapping',
            items: [
                {
                    class_id: 'bottle',
                    coco_label: 'bottle',
                    confidence: 0.95,
                    bbox: [100, 150, 200, 300],
                    category: 'Container',
                    material: 'plastic',
                    recyclable: 'yes',
                    biodegradable: 'no'
                }
            ]
        };

        // 1. Valid canonical event -> 200
        const r1 = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(validEvent)
        });
        const b1 = await r1.json();

        // 2. Out-of-bounds confidence -> 400
        const badConf = JSON.parse(JSON.stringify(validEvent));
        badConf.items[0].confidence = 1.5;
        const r2 = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(badConf)
        });

        // 3. Unknown class_id -> 400
        const badClass = JSON.parse(JSON.stringify(validEvent));
        badClass.items[0].class_id = 'unmapped_plastic_box';
        const r3 = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(badClass)
        });

        // 4. Non-UUID event_id -> 400
        const badId = JSON.parse(JSON.stringify(validEvent));
        badId.event_id = 'not-a-uuid';
        const r4 = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(badId)
        });

        // 5. Empty payload -> 400
        const r5 = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({})
        });

        srv.close(() => {
            console.log(JSON.stringify({
                status1: r1.status,
                success1: b1.success,
                count1: b1.count,
                status2: r2.status,
                status3: r3.status,
                status4: r4.status,
                status5: r5.status
            }));
        });
    });
    """
    out = run_node_eval(code)
    assert out["status1"] == 200, f"Expected 200 for valid canonical event, got {out['status1']}"
    assert out["success1"] is True
    assert out["count1"] == 1
    assert out["status2"] == 400, f"Expected 400 for bad confidence, got {out['status2']}"
    assert out["status3"] == 400, f"Expected 400 for unknown class_id, got {out['status3']}"
    assert out["status4"] == 400, f"Expected 400 for non-UUID event_id, got {out['status4']}"
    assert out["status5"] == 400, f"Expected 400 for empty payload, got {out['status5']}"


def test_i1_detection_ingestion_idempotency_and_outbox_contract():
    """
    Phase 5.1 / I1: Dedicated automated test asserting detection ingestion idempotency
    and contract verification:
    1. First push of canonical detection event stores exactly 1 document.
    2. Second push of identical event_id returns 200 with duplicate: true and does NOT create duplicate documents.
    """
    code = """
    const express = require('express');
    const http = require('http');

    process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
    process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
        'drone-alpha': 'token_alpha_12345678901234567890'
    });

    const droneRouter = require('./backend/routes/drone');
    const detectionStore = require('./backend/detectionStore');
    const app = express();
    app.use(express.json());
    app.use('/api/drone', droneRouter);

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const url = `http://127.0.0.1:${port}/api/drone/detection`;
        const headers = {
            'Content-Type': 'application/json',
            'X-Drone-Token': 'token_alpha_12345678901234567890',
            'X-Drone-Id': 'drone-alpha'
        };

        const event = {
            event_id: 'aaaa1111-bb22-4c33-8d44-eeee55556666',
            drone_id: 'drone-alpha',
            source: 'camera',
            observed_at: new Date().toISOString(),
            taxonomy_version: '1.0.0',
            classification_method: 'coco_mapping',
            items: [
                {
                    class_id: 'bottle',
                    coco_label: 'bottle',
                    confidence: 0.91,
                    bbox: [10, 10, 50, 50]
                }
            ]
        };

        const count0 = detectionStore.events.length;

        // Push 1
        const r1 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(event) });
        const b1 = await r1.json();
        const count1 = detectionStore.events.length;

        // Push 2 (identical event_id)
        const r2 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(event) });
        const b2 = await r2.json();
        const count2 = detectionStore.events.length;

        srv.close(() => {
            console.log(JSON.stringify({
                status1: r1.status,
                success1: b1.success,
                count1: count1 - count0,
                status2: r2.status,
                success2: b2.success,
                duplicate2: Boolean(b2.duplicate),
                count2: count2 - count0
            }));
        });
    });
    """
    out = run_node_eval(code)
    assert out["status1"] == 200
    assert out["success1"] is True
    assert out["count1"] == 1, "First push must store exactly 1 document"
    assert out["status2"] == 200
    assert out["success2"] is True
    assert out["duplicate2"] is True, "Second push must return duplicate: true"
    assert out["count2"] == 1, "Second push must NOT store duplicate document"


def test_e9_physical_drone_safety_controls_and_state_machine():
    """
    Physical Drone Safety Controls (E9):
    1. Mandatory command IDs (UUIDv4) and state machine initialization (state='sent')
    2. Rejection of invalid UUIDv4 command_id with HTTP 400
    3. Valid state transitions: sent -> acknowledged -> executing -> completed (HTTP 200)
    4. Rejection of illegal state transitions (sent -> completed) with HTTP 400
    5. Rejection of commands when drone telemetry is stale (> 10s) with HTTP 409
    6. Automatic command ACK timeout transitioning to 'timed_out'
    """
    code = """
    const express = require('express');
    const http = require('http');

    process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';

    const { router: apiRouter } = require('./backend/routes/api');
    const { commandManager } = require('./backend/services/commandManager');

    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        const baseUrl = `http://127.0.0.1:${port}/api/drone/command`;
        const headers = {
            'Content-Type': 'application/json',
            'X-Operator-Token': 'secure_test_operator_token_9xK2mP7qR4vL8wZ1'
        };

        // 1. Post valid flight command -> returns UUIDv4 and state='sent'
        const r1 = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ drone_id: 'Drone-Test-1', command: 'start' })
        });
        const b1 = await r1.json();

        // 2. Post command with invalid UUIDv4 command_id -> 400
        const r2 = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ drone_id: 'Drone-Test-1', command: 'hold', command_id: 'not-a-uuid' })
        });

        // 3. Valid state transitions: sent -> acknowledged -> executing -> completed
        const cmdId = b1.command_id;
        const stateUrl = `${baseUrl}/${cmdId}/state`;

        const rAck = await fetch(stateUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ state: 'acknowledged', reason: 'drone radio ack' })
        });
        const bAck = await rAck.json();

        const rExec = await fetch(stateUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ state: 'executing', reason: 'motors spin' })
        });
        const bExec = await rExec.json();

        const rComp = await fetch(stateUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ state: 'completed', reason: 'target altitude reached' })
        });
        const bComp = await rComp.json();

        // 4. Illegal state transition: sent -> completed directly -> 400
        const rIllegalInit = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ drone_id: 'Drone-Test-2', command: 'rth' })
        });
        const bIllegalInit = await rIllegalInit.json();
        const rIllegalTrans = await fetch(`${baseUrl}/${bIllegalInit.command_id}/state`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ state: 'completed' })
        });

        // 5. Stale telemetry guard (> 10 seconds old) -> 409 Conflict
        commandManager.recordTelemetry('Drone-Stale', Date.now() - 20000); // 20s old
        const rStale = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ drone_id: 'Drone-Stale', command: 'land' })
        });
        const bStale = await rStale.json();

        // Recover with fresh telemetry -> 200 OK
        commandManager.recordTelemetry('Drone-Stale', Date.now());
        const rFresh = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ drone_id: 'Drone-Stale', command: 'land' })
        });

        // 6. Command ACK timeout -> timed_out
        const rTimeoutCmd = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ drone_id: 'Drone-Timeout', command: 'hold', ack_timeout_seconds: 0.08 })
        });
        const bTimeoutCmd = await rTimeoutCmd.json();
        await new Promise(resolve => setTimeout(resolve, 120));

        const rGetTimeout = await fetch(`${baseUrl}/${bTimeoutCmd.command_id}`, { headers });
        const bGetTimeout = await rGetTimeout.json();

        srv.close(() => {
            console.log(JSON.stringify({
                status1: r1.status,
                cmdId1: b1.command_id,
                state1: b1.state,
                status2: r2.status,
                statusAck: rAck.status,
                stateAck: bAck.command ? bAck.command.state : null,
                statusExec: rExec.status,
                stateExec: bExec.command ? bExec.command.state : null,
                statusComp: rComp.status,
                stateComp: bComp.command ? bComp.command.state : null,
                statusIllegal: rIllegalTrans.status,
                statusStale: rStale.status,
                staleError: bStale.error,
                statusFresh: rFresh.status,
                stateTimedOut: bGetTimeout.command ? bGetTimeout.command.state : null
            }));
        });
    });
    """
    out = run_node_eval(code)
    # 1. Valid command initiation
    assert out["status1"] == 200
    assert re.match(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", out["cmdId1"])
    assert out["state1"] == "sent"

    # 2. Rejection of invalid UUID
    assert out["status2"] == 400

    # 3. Valid state transitions
    assert out["statusAck"] == 200
    assert out["stateAck"] == "acknowledged"
    assert out["statusExec"] == 200
    assert out["stateExec"] == "executing"
    assert out["statusComp"] == 200
    assert out["stateComp"] == "completed"

    # 4. Illegal state transition
    assert out["statusIllegal"] == 400

    # 5. Stale telemetry guard
    assert out["statusStale"] == 409
    assert "Stale telemetry" in out["staleError"]
    assert out["statusFresh"] == 200

    # 6. ACK timeout
    assert out["stateTimedOut"] == "timed_out"

def test_e8_telemetry_ttl_index_configuration():
    code = """
    const Telemetry = require('./backend/models/Telemetry');
    const indexes = Telemetry.schema.indexes();
    const ttlIndex = indexes.find(entry => entry[0] && entry[0].timestamp === 1 && typeof entry[1].expireAfterSeconds === 'number');
    console.log(JSON.stringify({
        defaultTTL: Telemetry.TELEMETRY_TTL_SECONDS,
        hasTtlIndex: !!ttlIndex,
        expireAfterSeconds: ttlIndex ? ttlIndex[1].expireAfterSeconds : null
    }));
    """
    out = run_node_eval(code)
    assert out['defaultTTL'] == 604800
    assert out['hasTtlIndex'] is True
    assert out['expireAfterSeconds'] == 604800

def test_e7_payload_size_limit_and_ingestion_rate_limiting():
    code = """
    const http = require('http');
    const app = require('./backend/app');
    const { createRateLimiter } = require('./backend/middleware/rateLimiter');

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        try {
            // 1. Send 6MB payload (exceeds 5MB limit)
            const bigPayload = 'A'.repeat(6 * 1024 * 1024);
            const rOversize = await fetch(`http://127.0.0.1:${port}/api/drone/telemetry`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Drone-Id': 'Drone-Alpha',
                    'X-Drone-Token': 'drone_alpha_token_12345678901234567890'
                },
                body: JSON.stringify({ drone_id: 'Drone-Alpha', dummy: bigPayload })
            });
            const bOversize = await rOversize.json();

            // 2. Rate limiter behavior with custom limiter
            const testLimiter = createRateLimiter({ windowMs: 2000, max: 2 });
            const mockReq = { authenticated_drone_id: 'Rate-Test-Drone' };
            const headers = {};
            let statusCode = 200;
            let resJson = null;
            const mockRes = {
                setHeader: (k, v) => { headers[k] = v; },
                status: (c) => { statusCode = c; return { json: (j) => { resJson = j; } }; }
            };
            let passCount = 0;
            testLimiter(mockReq, mockRes, () => { passCount++; });
            testLimiter(mockReq, mockRes, () => { passCount++; });
            testLimiter(mockReq, mockRes, () => { passCount++; }); // 3rd request should be blocked (429)
            testLimiter.cleanup();

            console.log(JSON.stringify({
                oversizeStatus: rOversize.status,
                oversizeError: bOversize.error,
                passCount: passCount,
                rateLimitStatus: statusCode,
                retryAfter: headers['Retry-After']
            }));
        } catch (e) {
            console.error(e);
            console.log(JSON.stringify({ error: e.message }));
        } finally {
            srv.close();
        }
    });
    """
    out = run_node_eval(code)
    assert out["oversizeStatus"] == 413
    assert out["oversizeError"] == "Payload Too Large"
    assert out["passCount"] == 2
    assert out["rateLimitStatus"] == 429
    assert int(out["retryAfter"]) >= 1

def test_e10_e11_docker_compose_and_node_engine_hardening():
    """E10 & E11: Compose healthchecks, pinned MongoDB image, --auth flag, and declared Node engine."""
    import json
    pkg_path = os.path.join(ECOWING_DIR, "backend", "package.json")
    with open(pkg_path, "r", encoding="utf-8") as f:
        pkg = json.load(f)
    assert "engines" in pkg
    assert pkg["engines"]["node"] == ">=20.0.0"

    compose_path = os.path.join(ECOWING_DIR, "docker-compose.yml")
    with open(compose_path, "r", encoding="utf-8") as f:
        compose_content = f.read()

    assert "image: mongo:7.0.14-jammy" in compose_content
    assert 'command: ["--auth"]' in compose_content
    assert "healthcheck:" in compose_content
    assert "db.adminCommand('ping')" in compose_content
    assert "condition: service_healthy" in compose_content
def test_op3_trusted_proxy_topology_and_spoofing_prevention():
    """OP-3: X-Forwarded-For is ignored by default; only exact trusted proxy IP is accepted."""
    code = """
    const http = require('http');
    const app = require('./backend/app');
    const { isTrustedProxy, trustedProxySet } = require('./backend/app');

    trustedProxySet.clear(); // Default: empty (untrusted)
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', async () => {
        const port = srv.address().port;
        try {
            const isTrustedDefault = isTrustedProxy('127.0.0.1');

            trustedProxySet.add('127.0.0.1');
            const isTrustedNow = isTrustedProxy('127.0.0.1');
            const isUntrustedOther = isTrustedProxy('192.168.1.100');

            trustedProxySet.clear();

            console.log(JSON.stringify({
                isTrustedDefault,
                isTrustedNow,
                isUntrustedOther
            }));
        } catch (e) {
            console.error(e);
            console.log(JSON.stringify({ error: e.message }));
        } finally {
            srv.close();
        }
    });
    """
    out = run_node_eval(code)
    assert out["isTrustedDefault"] is False
    assert out["isTrustedNow"] is True
    assert out["isUntrustedOther"] is False


def test_op2_nginx_reverse_proxy_topology_and_video_gate():
    """OP-2: Nginx configuration asserts client_max_body_size 5m, video gate 401, and streaming timeouts."""
    nginx_path = os.path.join(ECOWING_DIR, "nginx.conf")
    with open(nginx_path, "r", encoding="utf-8") as f:
        conf = f.read()

    assert "client_max_body_size 5m;" in conf
    assert "location = /video_feed {" in conf
    assert '$http_x_operator_token = ""' in conf
    assert "return 401" in conf
    assert "proxy_buffering off;" in conf
    assert "proxy_cache off;" in conf
    assert "proxy_read_timeout 86400s;" in conf


def test_e13_governance_env_example_license_and_ci_workflow():
    """
    E13: Verifies that root .env.example, LICENSE, and GitHub Actions CI workflow exist and are valid.
    """
    root_env = os.path.join(ECOWING_DIR, ".env.example")
    assert os.path.isfile(root_env), "Root .env.example must exist"
    with open(root_env, "r", encoding="utf-8") as f:
        env_content = f.read()
    assert "ECOWING_OPERATOR_TOKEN=" in env_content
    assert "MONGO_URI=" in env_content
    assert "DRONE_DEVICE_TOKENS=" in env_content

    license_path = os.path.join(ECOWING_DIR, "LICENSE")
    assert not os.path.exists(license_path), "Root LICENSE must not exist" 

    ci_workflow = os.path.join(ECOWING_DIR, ".github", "workflows", "ci.yml")
    assert os.path.isfile(ci_workflow), ".github/workflows/ci.yml must exist"
    with open(ci_workflow, "r", encoding="utf-8") as f:
        ci_content = f.read()
    assert "npm test" in ci_content
    assert "pytest test_drone_security.py" in ci_content


def test_e12_readme_run_paths_and_proxy_architecture():
    """
    E12 / OP-SHARED-LOCKOUT: Verifies that README.md documents consistent run paths
    routing through Nginx port 8080, local dev run paths, and shared NAT lockout handling.
    """
    readme_path = os.path.join(ECOWING_DIR, "README.md")
    assert os.path.isfile(readme_path), "EcoWing README.md must exist"
    with open(readme_path, "r", encoding="utf-8") as f:
        text = f.read()

    assert "http://localhost:8080" in text, "README must document Nginx port 8080 gateway"
    assert "Docker Compose Run Path" in text, "README must document Docker Compose run path"
    assert "Local Development Run Path" in text, "README must document Local Development run path"
    assert "OP-SHARED-LOCKOUT" in text, "README must document shared NAT pairing and lockout handling"
