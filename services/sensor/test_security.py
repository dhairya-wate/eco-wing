import io
import os
import sys
import json
import time
import threading
import urllib.request
import subprocess
from pathlib import Path
import pytest
import numpy as np
import cv2
import uvicorn
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

# Environment variables are already set by conftest.py prior to importing app
from app import (
    app, active_pairing_codes, active_mobile_sessions,
    ip_failed_exchange_attempts, ip_exchange_rate_limits,
    prune_stale_records, get_client_ip, parse_image_dimensions,
    active_mobile_websockets, pending_mobile_websockets,
    CLOSE_REASONS, MAX_MOBILE_WS_CONNECTIONS
)
from config import MAX_UPLOAD_SIZE_BYTES
import asyncio
import websockets
from conftest import TEST_OPERATOR_TOKEN

client = TestClient(app)

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

def test_auth_missing_header_returns_401():
    """Unauthenticated requests without X-Operator-Token header return 401."""
    res = client.get("/api/system_info")
    assert res.status_code == 401
    assert "detail" in res.json()

def test_auth_query_param_token_rejected_returns_401():
    """Query parameter ?token= must be rejected with 401 (header-only authentication)."""
    res = client.get(f"/api/system_info?token={TEST_OPERATOR_TOKEN}")
    assert res.status_code == 401

def test_auth_valid_header_returns_200():
    """Requests with valid X-Operator-Token header succeed with 200."""
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}
    res = client.get("/api/system_info", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "online"
    assert "video_stream_url" in body

def test_upload_oversize_file_returns_413():
    """Uploads exceeding MAX_UPLOAD_SIZE_BYTES (5 MB) return 413."""
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}
    oversize_bytes = b"0" * (5 * 1024 * 1024 + 512 * 1024)
    files = {"file": ("large_image.jpg", io.BytesIO(oversize_bytes), "image/jpeg")}
    res = client.post("/api/upload", headers=headers, files=files)
    assert res.status_code == 413

def test_upload_corrupt_invalid_image_returns_400():
    """Uploads with corrupt/invalid image format return 400 Bad Request."""
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}
    corrupt_bytes = b"NOT_A_VALID_JPEG_HEADER"
    files = {"file": ("corrupt.jpg", io.BytesIO(corrupt_bytes), "image/jpeg")}
    res = client.post("/api/upload", headers=headers, files=files)
    assert res.status_code == 400

def test_upload_invalid_dimensions_returns_400():
    """Uploads with image dimensions outside allowed limits return 400."""
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}
    tiny_img = np.zeros((8, 8, 3), dtype=np.uint8)
    _, buf = cv2.imencode('.jpg', tiny_img)
    files = {"file": ("tiny.jpg", io.BytesIO(buf.tobytes()), "image/jpeg")}
    res = client.post("/api/upload", headers=headers, files=files)
    assert res.status_code == 400
    assert "Image dimensions" in res.json().get("detail", "")

def test_ip_lockout_after_five_failed_exchanges():
    """5 failed exchanges from one IP set locked_until and produce an immediate 429 lockout."""
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}
    # Reset tracking state for clean test isolation
    ip_failed_exchange_attempts.clear()
    ip_exchange_rate_limits.clear()

    # Step 1: Create valid 8-char code
    res_code = client.post("/api/mobile/pairing_code", headers=headers)
    assert res_code.status_code == 200
    code = res_code.json()["pairing_code"]
    assert len(code) == 8

    # Step 2: Attempt 4 failed exchanges -> 401 Unauthorized
    for i in range(4):
        res = client.post("/api/mobile/exchange", json={"code": f"WRONG{i}"})
        assert res.status_code == 401
        assert "Invalid or expired" in res.json().get("detail", "")

    # Step 3: 5th failure triggers IP lockout with 429 Too Many Requests
    res_5th = client.post("/api/mobile/exchange", json={"code": "WRONG5"})
    assert res_5th.status_code == 429
    assert "locked out for 10 minutes" in res_5th.json().get("detail", "")

    # Assert locked_until is set to a future timestamp in ip_failed_exchange_attempts
    client_ip = "testclient" # Starlette default host
    assert ip_failed_exchange_attempts[client_ip]["locked_until"] > time.time()

    # Step 4: Subsequent request even with real code is rejected with 429
    res_real = client.post("/api/mobile/exchange", json={"code": code})
    assert res_real.status_code == 429
    assert "temporarily locked out" in res_real.json().get("detail", "")

def test_mobile_stream_in_band_auth_and_session_replay_rejected():
    """
    WebSocket /ws/mobile_stream uses in-band auth message.
    The session token is consumed on connect, preventing replay by a second socket.
    """
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}
    ip_failed_exchange_attempts.clear()
    ip_exchange_rate_limits.clear()

    # 1. Generate pairing code
    res_code = client.post("/api/mobile/pairing_code", headers=headers)
    assert res_code.status_code == 200
    code = res_code.json()["pairing_code"]

    # 2. Exchange for session token
    res_ex = client.post("/api/mobile/exchange", json={"code": code})
    assert res_ex.status_code == 200
    session_token = res_ex.json()["session_token"]

    # 3. Handshake without valid auth message is rejected with 1008
    with pytest.raises(WebSocketDisconnect) as exc1:
        with client.websocket_connect("/ws/mobile_stream") as ws_bad:
            ws_bad.send_text(json.dumps({"type": "not_auth"}))
            ws_bad.receive_text()
    assert exc1.value.code == 1008

    # 4. Valid in-band auth succeeds
    with client.websocket_connect("/ws/mobile_stream") as ws_good:
        ws_good.send_text(json.dumps({"type": "auth", "session": session_token}))
        reply = json.loads(ws_good.receive_text())
        assert reply["type"] == "auth_ok"
        # Send a blank frame
        ws_good.send_bytes(b"\xff\xd8\xff\xe0")
        fb = json.loads(ws_good.receive_text())
        assert fb["type"] == "detection_feedback"

    # 5. REPLAY TEST: Connecting a second socket with the SAME session token fails
    # because the session was consumed immediately upon initial connection.
    with pytest.raises(WebSocketDisconnect) as exc_replay:
        with client.websocket_connect("/ws/mobile_stream") as ws_replay:
            ws_replay.send_text(json.dumps({"type": "auth", "session": session_token}))
            ws_replay.receive_text()
    assert exc_replay.value.code == 1008

def test_public_endpoints_accessible_without_token():
    """Verify that /api/detections and /ws remain public without auth."""
    # 1. /api/detections
    res = client.get("/api/detections")
    assert res.status_code == 200
    assert res.json()["status"] == "success"

    # 2. /ws telemetry
    with client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "telemetry"

def test_video_feed_http_streaming_chunk():
    """Verify GET /video_feed over real HTTP returns 200 and yields multipart JPEG chunks."""
    port = 5998
    server_cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    srv = uvicorn.Server(server_cfg)
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()

    time.sleep(1.0) # Wait for TCP bind

    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{port}/video_feed", timeout=10)
        assert req.status == 200
        assert "multipart/x-mixed-replace" in req.headers.get("Content-Type", "")
        # Read at least one multipart chunk
        chunk = req.read(2048)
        assert len(chunk) > 0
        assert b"--frame" in chunk or b"Content-Type: image/jpeg" in chunk
        req.close()
    finally:
        srv.should_exit = True

def test_upload_tiny_file_declares_huge_dimensions_rejects_without_imdecode(monkeypatch):
    """
    A tiny file declaring dimensions > 4096 (e.g. 5000x100) is rejected with 400
    directly by header parsing BEFORE cv2.imdecode is ever called.
    """
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}
    import struct
    png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 5000, 100) + b"\x08\x02\x00\x00\x00"

    imdecode_called = False
    def fake_imdecode(*args, **kwargs):
        nonlocal imdecode_called
        imdecode_called = True
        return None

    monkeypatch.setattr(cv2, "imdecode", fake_imdecode)

    files = {"file": ("tiny_huge_dims.png", io.BytesIO(png_bytes), "image/png")}
    res = client.post("/api/upload", headers=headers, files=files)
    assert res.status_code == 400
    assert "Image dimensions (5000x100) outside allowed limits" in res.json().get("detail", "")
    assert not imdecode_called, "cv2.imdecode MUST NOT be called when header dimensions violate bounds!"

def test_upload_declared_content_length_exceeds_limit_returns_413():
    """Requests declaring Content-Length exceeding 5MB are rejected immediately with 413."""
    headers = {
        "X-Operator-Token": TEST_OPERATOR_TOKEN,
        "Content-Length": str(10 * 1024 * 1024)
    }
    tiny_img = np.zeros((32, 32, 3), dtype=np.uint8)
    _, buf = cv2.imencode('.jpg', tiny_img)
    files = {"file": ("sample.jpg", io.BytesIO(buf.tobytes()), "image/jpeg")}
    res = client.post("/api/upload", headers=headers, files=files)
    assert res.status_code == 413

def test_mobile_ws_auth_error_handling_cases():
    """
    Wrap the entire auth step in error handling.
    Any binary frame, invalid JSON, wrong message type, or missing session closes with 1008.
    """
    # 1. Binary frame sent before authentication -> 1008
    with pytest.raises(WebSocketDisconnect) as exc_bin:
        with client.websocket_connect("/ws/mobile_stream") as ws:
            ws.send_bytes(b"\x00\x01\x02\x03")
            ws.receive_text()
    assert exc_bin.value.code == 1008

    # 2. Invalid JSON sent first -> 1008
    with pytest.raises(WebSocketDisconnect) as exc_json:
        with client.websocket_connect("/ws/mobile_stream") as ws:
            ws.send_text("NOT_VALID_JSON{{{")
            ws.receive_text()
    assert exc_json.value.code == 1008

    # 3. Wrong message type -> 1008
    with pytest.raises(WebSocketDisconnect) as exc_type:
        with client.websocket_connect("/ws/mobile_stream") as ws:
            ws.send_text(json.dumps({"type": "ping"}))
            ws.receive_text()
    assert exc_type.value.code == 1008

    # 4. Missing session field -> 1008
    with pytest.raises(WebSocketDisconnect) as exc_sess:
        with client.websocket_connect("/ws/mobile_stream") as ws:
            ws.send_text(json.dumps({"type": "auth"}))
            ws.receive_text()
    assert exc_sess.value.code == 1008

    # 5. Invalid / unknown session -> 1008
    with pytest.raises(WebSocketDisconnect) as exc_bad_sess:
        with client.websocket_connect("/ws/mobile_stream") as ws:
            ws.send_text(json.dumps({"type": "auth", "session": "unknown_session_token_1234567890"}))
            ws.receive_text()
    assert exc_bad_sess.value.code == 1008

def test_trusted_proxies_resolution_docker_and_untrusted(monkeypatch):
    """
    Verifies that:
    1. Default TRUSTED_PROXIES is empty, so proxy-forwarded IPs (X-Forwarded-For) are ignored
       and the direct socket peer is always used.
    2. When an exact IP is configured in TRUSTED_PROXIES, X-Forwarded-For is accepted ONLY from
       that exact peer, and ignored for other subnet addresses and untrusted peers.
    """
    from starlette.requests import Request
    import app as app_module

    # Part 1: Default state (TRUSTED_PROXIES is empty) -> X-Forwarded-For is ignored everywhere
    monkeypatch.setattr(app_module, "TRUSTED_PROXIES", set())

    # Peer is Docker gateway IP -> ignored because list is empty
    scope_default_docker = {
        "type": "http",
        "client": ("172.17.0.1", 54321),
        "headers": [(b"x-forwarded-for", b"203.0.113.195, 10.0.0.1")]
    }
    req_default_docker = Request(scope_default_docker)
    assert get_client_ip(req_default_docker) == "172.17.0.1"

    # Peer is localhost -> ignored because list is empty
    scope_default_local = {
        "type": "http",
        "client": ("127.0.0.1", 54321),
        "headers": [(b"x-forwarded-for", b"203.0.113.195")]
    }
    req_default_local = Request(scope_default_local)
    assert get_client_ip(req_default_local) == "127.0.0.1"

    # Part 2: Explicitly configured TRUSTED_PROXIES with exact gateway IP
    monkeypatch.setattr(app_module, "TRUSTED_PROXIES", {"172.17.0.1"})

    # Exact match -> trust X-Forwarded-For
    req_trusted = Request(scope_default_docker)
    assert get_client_ip(req_trusted) == "203.0.113.195"

    # Other container in subnet (172.17.0.5) -> not in TRUSTED_PROXIES (no subnets) -> socket IP
    scope_subnet = {
        "type": "http",
        "client": ("172.17.0.5", 54321),
        "headers": [(b"x-forwarded-for", b"203.0.113.195")]
    }
    req_subnet = Request(scope_subnet)
    assert get_client_ip(req_subnet) == "172.17.0.5"

    # Untrusted LAN IP (192.168.1.100) -> use socket IP
    scope_untrusted = {
        "type": "http",
        "client": ("192.168.1.100", 54321),
        "headers": [(b"x-forwarded-for", b"203.0.113.195")]
    }
    req_untrusted = Request(scope_untrusted)
    assert get_client_ip(req_untrusted) == "192.168.1.100"

def test_unauthenticated_sockets_count_against_connection_cap():
    """
    Pending (unauthenticated) mobile sockets count against MAX_MOBILE_WS_CONNECTIONS (5).
    Opening more unauthenticated sockets than the cap rejects the excess socket with code 1013.
    """
    pending_mobile_websockets.clear()
    active_mobile_websockets.clear()

    sockets = []
    try:
        # Open 5 unauthenticated sockets concurrently (reaching MAX_MOBILE_WS_CONNECTIONS = 5)
        for _ in range(5):
            ws = client.websocket_connect("/ws/mobile_stream")
            ws.__enter__()
            sockets.append(ws)

        # 6th socket exceeds connection cap (both active and pending count) -> 1013
        with pytest.raises(WebSocketDisconnect) as exc_cap:
            with client.websocket_connect("/ws/mobile_stream") as ws_excess:
                ws_excess.receive_text()
        assert exc_cap.value.code == 1013
        assert "Mobile connection limit reached" in exc_cap.value.reason
    finally:
        for ws in sockets:
            try:
                ws.close()
                ws.__exit__(None, None, None)
            except Exception:
                pass
        pending_mobile_websockets.clear()
        active_mobile_websockets.clear()

def test_pre_accept_closes_disabled_and_capped_paths(monkeypatch):
    """
    Pre-accept closes deliver standard RFC 6455 close frames:
    - Code 1008 when MOBILE_ENABLED=False
    - Code 1013 when connection cap is reached
    """
    # 1. Disabled path -> 1008
    import app as app_module
    monkeypatch.setattr(app_module, "MOBILE_ENABLED", False)

    with pytest.raises(WebSocketDisconnect) as exc_dis:
        with client.websocket_connect("/ws/mobile_stream") as ws_dis:
            ws_dis.receive_text()
    assert exc_dis.value.code == 1008
    assert "Mobile streaming disabled" in exc_dis.value.reason

    # 2. Capped path -> 1013
    monkeypatch.setattr(app_module, "MOBILE_ENABLED", True)
    # Simulate connection cap reached
    fake_set = {f"ws_{i}" for i in range(5)}
    monkeypatch.setattr(app_module, "active_mobile_websockets", fake_set)

    with pytest.raises(WebSocketDisconnect) as exc_cap:
        with client.websocket_connect("/ws/mobile_stream") as ws_cap:
            ws_cap.receive_text()
    assert exc_cap.value.code == 1013
    assert "Mobile connection limit reached" in exc_cap.value.reason

def test_fixture_dimensions_parsed_from_all_seven_real_files():
    """
    Verifies that PNG, JPEG, GIF, BMP, WebP VP8 (lossy), WebP VP8L (lossless),
    and WebP VP8X (extended) all parse to exact dimensions (128x96) using real files.
    """
    fixtures_dir = Path(__file__).resolve().parent / "test_samples" / "fixtures"
    fixture_files = [
        "sample.png",
        "sample.jpg",
        "sample.gif",
        "sample.bmp",
        "sample_vp8.webp",
        "sample_vp8l.webp",
        "sample_vp8x.webp"
    ]
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}

    for fname in fixture_files:
        fpath = fixtures_dir / fname
        assert fpath.exists(), f"Fixture file {fname} not found on disk."
        data = fpath.read_bytes()

        # 1. Test header parsing logic directly
        w, h = parse_image_dimensions(data)
        assert (w, h) == (128, 96), f"Header parsing mismatch for {fname}: got ({w}x{h}), expected (128x96)"

        # 2. Test live upload endpoint with real file
        files = {"file": (fname, io.BytesIO(data), "application/octet-stream")}
        res = client.post("/api/upload", headers=headers, files=files)
        assert res.status_code == 200, f"Upload failed for {fname}: {res.text}"
        assert res.json()["status"] == "success"

def test_startup_fails_with_36_char_repeated_pattern_token():
    """DETECTION_OPERATOR_TOKEN with a 36-character repeated periodic pattern fails startup."""
    env = os.environ.copy()
    # 36 characters: 'abcd' repeated 9 times
    env["DETECTION_OPERATOR_TOKEN"] = "abcd" * 9
    proc = subprocess.run(
        [sys.executable, "-c", "import config"],
        env=env,
        capture_output=True,
        text=True
    )
    assert proc.returncode != 0
    assert "repeated pattern" in proc.stderr

def test_pruning_keeps_dictionaries_bounded():
    """Stale codes, sessions, rate limits, and lockouts are pruned on request."""
    past = time.time() - 1000.0
    active_pairing_codes["EXPIRED_CODE"] = {"expires_at": past}
    active_mobile_sessions["EXPIRED_SESS"] = {"expires_at": past}
    ip_exchange_rate_limits["10.0.0.9"] = [past]
    ip_failed_exchange_attempts["10.0.0.9"] = {"failed": 0, "locked_until": past}

    prune_stale_records()

    assert "EXPIRED_CODE" not in active_pairing_codes
    assert "EXPIRED_SESS" not in active_mobile_sessions
    assert "10.0.0.9" not in ip_exchange_rate_limits
    assert "10.0.0.9" not in ip_failed_exchange_attempts

def test_close_reasons_length_within_rfc6455_limit():
    """All fixed WebSocket close reason strings must strictly satisfy RFC 6455 limit (<= 123 bytes)."""
    for key, reason in CLOSE_REASONS.items():
        encoded = reason.encode("utf-8")
        assert len(encoded) <= 123, f"Close reason '{key}' exceeds 123 bytes ({len(encoded)} bytes)"

def test_ip_lockout_expiry_reset_does_not_relock_immediately():
    """
    After lockout expiry, failed attempts reset to 0.
    A single subsequent wrong code returns 401 and does not immediately re-lock with 429.
    """
    headers = {"X-Operator-Token": TEST_OPERATOR_TOKEN}
    ip_failed_exchange_attempts.clear()
    ip_exchange_rate_limits.clear()

    # Create valid code
    res_code = client.post("/api/mobile/pairing_code", headers=headers)
    assert res_code.status_code == 200

    # Lockout client IP with 5 failed attempts
    for i in range(4):
        res = client.post("/api/mobile/exchange", json={"code": f"WRONG_{i}"})
        assert res.status_code == 401

    res_5th = client.post("/api/mobile/exchange", json={"code": "WRONG_LOCK"})
    assert res_5th.status_code == 429
    assert "locked out" in res_5th.json()["detail"]

    client_ip = "testclient"
    assert ip_failed_exchange_attempts[client_ip]["locked_until"] > time.time()

    # Simulate lockout expiry by advancing locked_until into the past
    ip_failed_exchange_attempts[client_ip]["locked_until"] = time.time() - 1.0

    # Send 1 wrong code after expiry -> must return 401, NOT 429!
    res_post_expiry = client.post("/api/mobile/exchange", json={"code": "WRONG_ONCE"})
    assert res_post_expiry.status_code == 401
    assert "Invalid or expired" in res_post_expiry.json()["detail"]
    assert ip_failed_exchange_attempts[client_ip]["failed"] == 1
    assert ip_failed_exchange_attempts[client_ip]["locked_until"] == 0.0

@pytest.mark.asyncio
async def test_concurrent_handshakes_gather_capped(monkeypatch):
    """
    Fires N+5 (10) concurrent handshakes with asyncio.gather against local server.
    Synchronous pending set registration asserts exactly MAX_MOBILE_WS_CONNECTIONS (5)
    are admitted and 5 are rejected with code 1013.
    """
    import app as app_module
    monkeypatch.setattr(app_module, "MOBILE_ENABLED", True)

    port = 5995
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", ws_max_size=MAX_UPLOAD_SIZE_BYTES)
    srv = uvicorn.Server(cfg)
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    await asyncio.sleep(1.0)

    try:
        uri = f"ws://127.0.0.1:{port}/ws/mobile_stream"
        async def connect_one(i):
            try:
                async with websockets.connect(uri) as ws:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=0.3)
                        return ("msg", msg)
                    except asyncio.TimeoutError:
                        return ("admitted", None)
            except websockets.exceptions.ConnectionClosed as e:
                return ("closed", e.rcvd.code if e.rcvd else None)
            except Exception as e:
                return ("err", str(e))

        res = await asyncio.gather(*[connect_one(i) for i in range(10)])
        admitted = sum(1 for status, code in res if status == "admitted")
        capped = sum(1 for status, code in res if code == 1013)

        assert admitted == MAX_MOBILE_WS_CONNECTIONS, f"Expected {MAX_MOBILE_WS_CONNECTIONS} admitted, got {admitted}"
        assert capped == 5, f"Expected 5 capped with 1013, got {capped}"
    finally:
        srv.should_exit = True

@pytest.mark.asyncio
async def test_ws_max_message_size_transport_rejection_code_1009():
    """
    Tests exact documented launch command:
    uvicorn app:app --host 127.0.0.1 --port 5000 --ws-max-size 5242880
    Asserts transport level closes with RFC 6455 code 1009 when a 6MB frame is received.
    """
    import socket
    port = 5996
    env = os.environ.copy()
    env["DETECTION_OPERATOR_TOKEN"] = TEST_OPERATOR_TOKEN
    env["MOBILE_ENABLED"] = "true"

    cmd = [
        sys.executable, "-m", "uvicorn", "app:app",
        "--host", "127.0.0.1",
        "--port", str(port),
        "--ws-max-size", str(MAX_UPLOAD_SIZE_BYTES)
    ]
    proc = subprocess.Popen(cmd, env=env)

    # Poll until TCP port is ready
    bound = False
    for _ in range(60):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=0.2)
            s.close()
            bound = True
            break
        except OSError:
            await asyncio.sleep(0.1)

    assert bound, "Uvicorn launch command failed to bind within timeout."

    try:
        # Step 1: Request pairing code via HTTP POST
        req1 = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/mobile/pairing_code",
            headers={"X-Operator-Token": TEST_OPERATOR_TOKEN},
            data=b"",
            method="POST"
        )
        with urllib.request.urlopen(req1) as res1:
            code = json.loads(res1.read().decode())["pairing_code"]

        # Step 2: Exchange pairing code for scoped session
        req2 = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/mobile/exchange",
            headers={"Content-Type": "application/json"},
            data=json.dumps({"code": code}).encode(),
            method="POST"
        )
        with urllib.request.urlopen(req2) as res2:
            session_token = json.loads(res2.read().decode())["session_token"]

        # Step 3: Connect WebSocket and send 6MB frame (> 5MB)
        uri = f"ws://127.0.0.1:{port}/ws/mobile_stream"
        async with websockets.connect(uri, max_size=10 * 1024 * 1024) as ws:
            await ws.send(json.dumps({"type": "auth", "session": session_token}))
            reply = json.loads(await ws.recv())
            assert reply["type"] == "auth_ok"

            oversize_data = b"Y" * (6 * 1024 * 1024)
            closed_code = None
            try:
                await ws.send(oversize_data)
                await ws.recv()
            except websockets.exceptions.ConnectionClosed as e:
                closed_code = e.rcvd.code if e.rcvd else None

            assert closed_code == 1009, f"Expected transport close code 1009, got {closed_code}"
    finally:
        proc.terminate()
        proc.wait()


