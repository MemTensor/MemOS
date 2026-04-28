"""Daemon manager for the MemOS bridge subprocess.

Responsibilities:
- Ensure exactly one bridge process runs per user home.
- Probe Node.js availability so ``MemTensorProvider.is_available`` can
  answer cheaply at plugin-startup time.
- Graceful shutdown helpers invoked from ``MemTensorProvider.shutdown``.
- PID file management to prevent duplicate bridge processes across
  Hermes session restarts.

This file intentionally has **no runtime dependency** on the client; the
provider instantiates its own client. Keeping these concerns split means
the dependency graph for the Hermes plugin stays acyclic:

    memos_provider/__init__.py ─┬─▶ bridge_client.py
                                └─▶ daemon_manager.py
"""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import threading
import time

from pathlib import Path


logger = logging.getLogger(__name__)

_lock = threading.Lock()
_bridge_ok: bool | None = None
_ACTIVE_BRIDGE_PROC: subprocess.Popen | None = None


# ─── PID file helpers ────────────────────────────────────────────────────


def _pid_path() -> Path:
    """Path to the singleton PID file under the plugin data directory."""
    return Path(__file__).resolve().parent.parent.parent.parent / "data" / "bridge.pid"


def _read_pid() -> int | None:
    try:
        return int(_pid_path().read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def _write_pid(pid: int) -> None:
    pid_path = _pid_path()
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(str(pid))


def _clean_pid() -> None:
    _pid_path().unlink(missing_ok=True)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, PermissionError):
        return False


# ─── Bridge lifecycle ────────────────────────────────────────────────────


def _bridge_script() -> Path:
    return Path(__file__).resolve().parent.parent.parent.parent / "bridge.cts"


def _node_available() -> bool:
    node = shutil.which("node")
    if not node:
        return False
    try:
        out = subprocess.check_output([node, "--version"], timeout=2.0)
        return bool(out.strip())
    except Exception:
        return False


def ensure_bridge_running(*, probe_only: bool = False) -> bool:
    """Return True when the bridge is (or can be) operational.

    ``probe_only=True`` performs a lightweight availability check without
    launching a long-lived subprocess. This is what
    ``MemTensorProvider.is_available`` calls during Hermes startup.
    """
    global _bridge_ok
    with _lock:
        if _bridge_ok is not None and probe_only:
            return _bridge_ok
        script = _bridge_script()
        if not script.exists():
            logger.warning("MemOS: bridge script missing at %s", script)
            _bridge_ok = False
            return False
        if not _node_available():
            logger.warning("MemOS: Node.js not found on PATH")
            _bridge_ok = False
            return False
        _bridge_ok = True
        return True


def kill_existing_bridge() -> None:
    """Kill any previously-running bridge process recorded in the PID file.

    Called **before** spawning a new bridge to guarantee at-most-one
    instance. Safe to call even when no stale PID exists.
    """
    pid = _read_pid()
    if pid is not None and _pid_alive(pid):
        logger.info("MemOS: killing stale bridge (pid=%d)", pid)
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(25):  # wait up to 2.5 s
                if not _pid_alive(pid):
                    break
                time.sleep(0.1)
            else:
                os.kill(pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
    _clean_pid()


def register_bridge(proc: subprocess.Popen | None) -> None:
    """Record the current running bridge process.

    Pass ``None`` (e.g. on close) to clear the registration and PID file.
    """
    global _ACTIVE_BRIDGE_PROC
    _ACTIVE_BRIDGE_PROC = proc
    if proc is not None:
        _write_pid(proc.pid)
    else:
        _clean_pid()


def shutdown_bridge() -> None:
    """Gracefully shut down the tracked bridge subprocess and clean PID file."""
    global _bridge_ok, _ACTIVE_BRIDGE_PROC
    with _lock:
        _bridge_ok = None
    if _ACTIVE_BRIDGE_PROC is not None:
        try:
            _ACTIVE_BRIDGE_PROC.terminate()
            _ACTIVE_BRIDGE_PROC.wait(timeout=5.0)
            logger.info("MemOS: bridge terminated (pid=%d)", _ACTIVE_BRIDGE_PROC.pid)
        except subprocess.TimeoutExpired:
            _ACTIVE_BRIDGE_PROC.kill()
            logger.warning("MemOS: bridge killed after timeout (pid=%d)", _ACTIVE_BRIDGE_PROC.pid)
        except Exception:
            pass
        _ACTIVE_BRIDGE_PROC = None
    _clean_pid()
