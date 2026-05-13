"""Daemon manager for the MemOS bridge subprocess.

Responsibilities:
- Ensure exactly one bridge process runs per user home.
- Probe Node.js availability so ``MemTensorProvider.is_available`` can
  answer cheaply at plugin-startup time.
- Graceful shutdown helpers invoked from ``MemTensorProvider.shutdown``.

This file intentionally has **no runtime dependency** on the client; the
provider instantiates its own client. Keeping these concerns split means
the dependency graph for the Hermes plugin stays acyclic:

    memos_provider/__init__.py ─┬─▶ bridge_client.py
                                └─▶ daemon_manager.py
"""

from __future__ import annotations

import logging
import os
import signal
import shutil
import subprocess
import threading
import time

from pathlib import Path


logger = logging.getLogger(__name__)

_lock = threading.Lock()
_bridge_ok: bool | None = None


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


def shutdown_bridge() -> None:
    """Best-effort cleanup; each client owns its own subprocess."""
    global _bridge_ok
    with _lock:
        _bridge_ok = None


def wait_for_process_exit(pid: int, timeout: float = 5.0) -> bool:
    """Wait for a process to exit.

    Returns True if the process has exited, False if still running after timeout.
    """
    start = time.time()
    while time.time() - start < timeout:
        try:
            # Check if process exists (signal 0 doesn't actually send a signal)
            os.kill(pid, 0)
            time.sleep(0.1)
        except (OSError, ProcessLookupError):
            # Process doesn't exist = has exited
            return True
    return False


def terminate_bridge_process(pid: int, timeout: float = 7.0) -> bool:
    """Terminate a bridge process gracefully, then forcefully if needed.

    Returns True if the process was successfully terminated.
    """
    try:
        # Check if process exists first
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return True  # Already gone

    try:
        # 1. Send SIGTERM (graceful shutdown)
        os.kill(pid, signal.SIGTERM)
        if wait_for_process_exit(pid, timeout=5.0):
            return True

        # 2. If still running, send SIGKILL (force kill)
        logger.warning("MemOS: bridge process %d did not exit after SIGTERM, sending SIGKILL", pid)
        os.kill(pid, signal.SIGKILL)
        return wait_for_process_exit(pid, timeout=2.0)
    except (OSError, ProcessLookupError):
        return True
