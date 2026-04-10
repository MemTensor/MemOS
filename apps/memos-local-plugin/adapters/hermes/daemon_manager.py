"""Manage the memos-core-bridge daemon lifecycle for hermes-agent.

The daemon is a long-running Node.js process that hosts both the JSON-RPC
bridge (TCP) and the memory viewer (HTTP).
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import signal
import socket
import subprocess
import time

from typing import Any

from config import (
    DAEMON_PORT,
    VIEWER_PORT,
    _get_plugin_root,
    find_bridge_script,
    get_bridge_config,
    get_daemon_dir,
    get_daemon_port,
)


logger = logging.getLogger(__name__)


def _is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def _tcp_ping(port: int, timeout: float = 2.0) -> bool:
    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        req = json.dumps({"id": 0, "method": "ping", "params": {}}) + "\n"
        sock.sendall(req.encode())
        sock.settimeout(timeout)
        data = b""
        while b"\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        sock.close()
        resp = json.loads(data.decode().strip())
        return resp.get("result", {}).get("pong", False)
    except Exception:
        return False


def is_daemon_running() -> bool:
    port = get_daemon_port()
    if _tcp_ping(port):
        return True

    daemon_dir = get_daemon_dir()
    pid_file = daemon_dir / "bridge.pid"

    if not pid_file.exists():
        return False

    try:
        pid = int(pid_file.read_text().strip())
    except (ValueError, OSError):
        return False

    if not _is_process_alive(pid):
        _cleanup_pid_files()
        return False

    return _tcp_ping(port)


def _cleanup_pid_files() -> None:
    daemon_dir = get_daemon_dir()
    for name in ("bridge.pid", "bridge.port", "viewer.url"):
        f = daemon_dir / name
        if f.exists():
            with contextlib.suppress(OSError):
                f.unlink()


def start_daemon(
    daemon_port: int = DAEMON_PORT,
    viewer_port: int = VIEWER_PORT,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Start the bridge daemon if not already running. Returns daemon info."""
    port = get_daemon_port()
    if _tcp_ping(port):
        daemon_dir = get_daemon_dir()
        viewer_url = ""
        vf = daemon_dir / "viewer.url"
        if vf.exists():
            viewer_url = vf.read_text().strip()
        pid = 0
        pf = daemon_dir / "bridge.pid"
        if pf.exists():
            with contextlib.suppress(ValueError, OSError):
                pid = int(pf.read_text().strip())
        logger.info("Daemon already responsive on port %d (shared)", port)
        return {
            "daemonPort": port,
            "viewerUrl": viewer_url,
            "pid": pid,
            "already_running": True,
        }

    bridge_cmd = find_bridge_script()
    bridge_cmd.extend(["--daemon", "--port", str(daemon_port), "--viewer-port", str(viewer_port)])

    env = {**os.environ}
    env["MEMOS_BRIDGE_CONFIG"] = json.dumps(get_bridge_config())
    env["OPENCLAW_STATE_DIR"] = str(get_daemon_dir().parent)

    log_dir = get_daemon_dir()

    logger.info("Starting daemon: %s", " ".join(bridge_cmd))

    with open(log_dir / "bridge.log", "a") as log_file:
        proc = subprocess.Popen(
            bridge_cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=log_file,
            env=env,
            cwd=str(_get_plugin_root()),
            start_new_session=True,
        )

        deadline = time.monotonic() + timeout
        info: dict[str, Any] = {}

        import select

        while time.monotonic() < deadline:
            if proc.poll() is not None:
                stderr_out = ""
                with contextlib.suppress(OSError):
                    stderr_out = (log_dir / "bridge.log").read_text()[-2000:]
                raise RuntimeError(
                    f"Daemon exited immediately with code {proc.returncode}.\nlog: {stderr_out}"
                )

            if proc.stdout and select.select([proc.stdout], [], [], 1.0)[0]:
                line = proc.stdout.readline().decode("utf-8").strip()
                if line:
                    try:
                        info = json.loads(line)
                        break
                    except json.JSONDecodeError:
                        logger.debug("Non-JSON stdout line from daemon: %s", line)

        if not info:
            raise RuntimeError("Daemon did not produce startup info within timeout")

    if proc.stdout:
        proc.stdout.close()

    info["already_running"] = False
    logger.info(
        "Daemon started: pid=%s, port=%s, viewer=%s",
        info.get("pid"),
        info.get("daemonPort"),
        info.get("viewerUrl"),
    )
    return info


def stop_daemon() -> bool:
    daemon_dir = get_daemon_dir()
    pid_file = daemon_dir / "bridge.pid"

    if not pid_file.exists():
        return False

    try:
        pid = int(pid_file.read_text().strip())
    except (ValueError, OSError):
        _cleanup_pid_files()
        return False

    if not _is_process_alive(pid):
        _cleanup_pid_files()
        return False

    try:
        os.kill(pid, signal.SIGTERM)
        for _ in range(10):
            time.sleep(0.5)
            if not _is_process_alive(pid):
                break
        else:
            os.kill(pid, signal.SIGKILL)
    except OSError:
        pass

    _cleanup_pid_files()
    return True


def ensure_daemon() -> dict[str, Any]:
    return start_daemon()
