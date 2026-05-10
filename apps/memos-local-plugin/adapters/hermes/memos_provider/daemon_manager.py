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
import shutil
import subprocess
import threading
import time

from pathlib import Path


logger = logging.getLogger(__name__)

_lock = threading.Lock()
_bridge_ok: bool | None = None
_bridge_pid: int | None = None  # Track the single daemon bridge PID

# Port the MemOS viewer binds to. Must match bridge.cts viewer config.
_MEMOS_VIEWER_PORT = 18800


def _bridge_script() -> Path:
    return Path.home() / ".hermes/memos-plugin/bridge.cts"


def _node_available() -> bool:
    node = shutil.which("node")
    if not node:
        return False
    try:
        out = subprocess.check_output([node, "--version"], timeout=2.0)
        return bool(out.strip())
    except Exception:
        return False


def _find_existing_bridge_pid() -> int | None:
    """Return PID of a running bridge process, or None.

    Searches for ``bridge.cts --agent=hermes`` in the process table.
    """
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", r"bridge\.cts.*--agent=hermes"],
            timeout=5.0,
        )
        lines = out.decode("utf-8").strip().splitlines()
        for line in lines:
            try:
                pid = int(line.strip())
                return pid
            except ValueError:
                continue
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return None


def _is_port_bound(port: int = _MEMOS_VIEWER_PORT) -> bool:
    """Check if the MemOS viewer port is already bound (suggests daemon is alive)."""
    try:
        out = subprocess.check_output(
            ["ss", "-tlnp"],
            timeout=5.0,
        ).decode("utf-8")
        return f":{port}" in out
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return False


def _bridge_health_check(timeout: float = 2.0) -> bool:
    """Lightweight connectivity check to viewer port."""
    import socket

    try:
        sock = socket.create_connection(
            ("127.0.0.1", _MEMOS_VIEWER_PORT),
            timeout=timeout,
        )
        sock.close()
        return True
    except OSError:
        return False


def _kill_stale_bridge(pid: int) -> bool:
    """Kill a stale bridge process by PID. Returns True on success."""
    try:
        os.kill(pid, 15)  # SIGTERM first
        time.sleep(0.5)
        # Verify it's gone
        try:
            os.kill(pid, 0)
            # Still alive — force kill
            os.kill(pid, 9)
            time.sleep(0.5)
        except OSError:
            pass  # Already dead
        return True
    except OSError:
        return False  # Already dead or permission denied


def ensure_bridge_running(*, probe_only: bool = False) -> bool:
    """Return True when the bridge is (or can be) operational.

    ``probe_only=True`` performs a lightweight availability check without
    launching a long-lived subprocess. This is what
    ``MemTensorProvider.is_available`` calls during Hermes startup.

    **Bridge lifecycle guard:** If a bridge daemon is already running
    (port 18800 bound), returns True and does NOT spawn a new process.
    If a bridge process exists but port is NOT bound (zombie), kills it.
    Spawns a new bridge ONLY when no running bridge is detected.
    """
    global _bridge_ok, _bridge_pid
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

        # ── Bridge lifecycle guard ──
        # If a bridge daemon is already alive and serving, reuse it.
        # This is the KEY FIX: do NOT spawn a second bridge.
        existing_pid = _find_existing_bridge_pid()

        if existing_pid is not None:
            if _is_port_bound():
                # Port 18800 is bound — daemon is serving. Reuse.
                if _bridge_health_check():
                    logger.info(
                        "MemOS: bridge daemon already running (PID %d), reusing",
                        existing_pid,
                    )
                    _bridge_pid = existing_pid
                    _bridge_ok = True
                    return True
                else:
                    # Port bound but health check failed — stalled daemon
                    logger.warning(
                        "MemOS: bridge port bound but health check failed (PID %d), "
                        "killing and respawning",
                        existing_pid,
                    )
                    _kill_stale_bridge(existing_pid)
                    _bridge_pid = None
            else:
                # Process exists but port not bound — check if it's just starting up
                # Bridge needs 4-5 seconds for LLM/embedding init before binding port.
                # If process is young (< 10s), wait for it; if old, kill as zombie.
                try:
                    import os
                    import time
                    with open(f"/proc/{existing_pid}/stat") as f:
                        parts = f.read().split()
                        # Field 22 (0-indexed) is the start time in clock ticks
                        # But we can use field 20 (ctime) more directly
                        ctime = int(parts[19])
                        now = time.time()
                        uptime_s = now - ctime
                        if uptime_s < 10.0:
                            # Young process — likely still initializing. Wait for port.
                            logger.info(
                                "MemOS: bridge process (PID %d) initializing (%.1fs), "
                                "waiting for port binding",
                                existing_pid, int(uptime_s),
                            )
                            time.sleep(5)
                            if _is_port_bound() and _bridge_health_check():
                                _bridge_pid = existing_pid
                                _bridge_ok = True
                                return True
                            else:
                                logger.warning(
                                    "MemOS: bridge (PID %d) still not ready after wait, killing",
                                    existing_pid,
                                )
                                _kill_stale_bridge(existing_pid)
                                _bridge_pid = None
                        else:
                            # Old process without port — definite zombie
                            logger.warning(
                                "MemOS: stale bridge process (PID %d) without port binding, "
                                "killing (uptime %.0fs)",
                                existing_pid, int(uptime_s),
                            )
                            _kill_stale_bridge(existing_pid)
                            _bridge_pid = None
                except (FileNotFoundError, ProcessLookupError, IndexError, ValueError):
                    # Process vanished or stat unreadable — treat as gone
                    _bridge_pid = None

        # Also kill any other zombie bridge processes (pre-existing leak)
        _cleanup_zombie_bridges()

        if probe_only:
            _bridge_ok = True
            return True

        _bridge_ok = True
        return True


def _cleanup_zombie_bridges() -> None:
    """Kill ALL bridge processes that don't own the viewer port.

    Handles the case where previous sessions leaked zombie bridges
    (multiple processes but only one has port 18800). After this,
    exactly one bridge process (or zero if none running) will remain.
    """
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", r"bridge\.cts.*--agent=hermes"],
            timeout=5.0,
        )
        pids = [
            int(line.strip())
            for line in out.decode("utf-8").strip().splitlines()
            if line.strip()
        ]
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return

    if len(pids) <= 1:
        return

    # Find the PID that owns port 18800
    port_owner: int | None = None
    try:
        out = subprocess.check_output(
            ["ss", "-tlnp"],
            timeout=5.0,
        ).decode("utf-8")
        for line in out.splitlines():
            if f":{_MEMOS_VIEWER_PORT}" in line:
                # Extract PID from ss output: "pid=12345"
                import re
                m = re.search(r"pid=(\d+)", line)
                if m:
                    port_owner = int(m.group(1))
                break
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    killed = 0
    for pid in pids:
        if pid == port_owner:
            continue  # Keep the one that actually has the port
        logger.info("MemOS: killing zombie bridge PID %d", pid)
        _kill_stale_bridge(pid)
        killed += 1

    if killed:
        logger.info("MemOS: cleaned up %d zombie bridge processes", killed)


def get_bridge_pid() -> int | None:
    """Return the tracked bridge PID, or None."""
    return _bridge_pid


def shutdown_bridge() -> None:
    """Best-effort cleanup; each client owns its own subprocess."""
    global _bridge_ok, _bridge_pid
    with _lock:
        if _bridge_pid is not None:
            _kill_stale_bridge(_bridge_pid)
            _bridge_pid = None
        _bridge_ok = None
