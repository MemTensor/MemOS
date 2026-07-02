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

import contextlib
import logging
import os
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request

from pathlib import Path


logger = logging.getLogger(__name__)

_lock = threading.RLock()
_bridge_ok: bool | None = None
_viewer_status: str | None = None
_viewer_last_probe_at = 0.0
_viewer_process: subprocess.Popen | None = None

HERMES_VIEWER_PORT = 18800
VIEWER_PROBE_TTL_SEC = 30.0
VIEWER_START_LOCK_TIMEOUT_SEC = 20.0
VIEWER_START_LOCK_STALE_SEC = 60.0


@contextlib.contextmanager
def _viewer_start_lock(timeout: float = VIEWER_START_LOCK_TIMEOUT_SEC):
    """Cross-process guard for the Hermes viewer daemon startup path."""
    lock_dir = _plugin_root() / "daemon" / "viewer-start.lock"
    lock_dir.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout
    acquired = False

    while True:
        try:
            lock_dir.mkdir()
            acquired = True
            with contextlib.suppress(Exception):
                (lock_dir / "owner").write_text(
                    f"pid={os.getpid()} started_at={time.time()}\n",
                    encoding="utf-8",
                )
            break
        except FileExistsError:
            stale = False
            with contextlib.suppress(Exception):
                stale = time.time() - lock_dir.stat().st_mtime > VIEWER_START_LOCK_STALE_SEC
            if stale:
                with contextlib.suppress(Exception):
                    shutil.rmtree(lock_dir)
                continue
            if time.time() >= deadline:
                yield False
                return
            time.sleep(0.1)

    try:
        yield True
    finally:
        if acquired:
            with contextlib.suppress(Exception):
                shutil.rmtree(lock_dir)


def _bridge_script() -> Path:
    """Pick the viewer-daemon entrypoint, preferring pure ESM.

    See ``bridge_client._bridge_script`` for the rationale. The two
    helpers intentionally share the same precedence so that the stdio
    bridge spawned by ``MemosBridgeClient`` and the viewer daemon
    spawned by ``ensure_viewer_daemon`` always end up on the same Node
    entry binary.
    """
    plugin_root = _plugin_root()
    candidates = (
        plugin_root / "dist" / "bridge.mjs",
        plugin_root / "dist" / "bridge.cjs",
        plugin_root / "bridge.mts",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return plugin_root / "bridge.cts"


def _plugin_root() -> Path:
    plugin_root = Path(__file__).resolve().parent.parent.parent.parent
    if plugin_root.name == "dist":
        return plugin_root.parent
    return plugin_root


def _node_available() -> bool:
    node = _node_binary()
    if not node:
        return False
    try:
        out = subprocess.check_output([node, "--version"], timeout=2.0)
        return bool(out.strip())
    except Exception:
        return False


def _installed_node_binary(plugin_root: Path) -> str | None:
    marker = plugin_root / ".memos-node-bin"
    try:
        candidate = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return None


def _node_binary() -> str | None:
    plugin_root = _plugin_root()
    return (
        os.environ.get("MEMOS_NODE_BINARY")
        or _installed_node_binary(plugin_root)
        or shutil.which("node")
    )


def _bridge_command(*, daemon: bool) -> list[str]:
    plugin_root = _plugin_root()
    node = _node_binary()
    if not node:
        raise RuntimeError("Node.js not found on PATH")
    script_path = _bridge_script()
    script = str(script_path)
    tsx_cli = plugin_root / "node_modules" / "tsx" / "dist" / "cli.mjs"
    bridge_args = [script, "--agent=hermes"]
    if daemon:
        bridge_args.append("--daemon")
    if script_path.suffix in (".mjs", ".cjs"):
        return [node, *bridge_args]
    if tsx_cli.exists():
        return [node, str(tsx_cli), *bridge_args]
    return [node, "--import", "tsx", *bridge_args]


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


def _probe_viewer() -> str:
    """Classify the service currently listening on Hermes' viewer port."""
    ping_url = f"http://127.0.0.1:{HERMES_VIEWER_PORT}/api/v1/ping"
    ping_status = _probe_json_url(ping_url)
    if ping_status == "free":
        return "free"
    if isinstance(ping_status, dict) and ping_status.get("service") == "memos-local-plugin":
        return "running_memos"

    # Backwards compatibility for already-running viewers installed before
    # `/api/v1/ping` carried a service marker.
    health_url = f"http://127.0.0.1:{HERMES_VIEWER_PORT}/api/v1/health"
    health_status = _probe_json_url(health_url)
    if health_status == "free":
        return "free"
    if not isinstance(health_status, dict):
        return "blocked"
    if (
        health_status.get("service") == "memos-local-plugin"
        and health_status.get("agent") == "hermes"
    ):
        return "running_memos"
    if health_status.get("agent") == "hermes" and isinstance(health_status.get("version"), str):
        return "running_memos"
    return "blocked"


def _probe_json_url(url: str) -> dict | str:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            content_type = resp.headers.get("content-type", "")
            raw = resp.read(8192)
    except urllib.error.URLError as err:
        reason = getattr(err, "reason", None)
        errno = getattr(reason, "errno", None)
        if errno in {61, 111}:  # macOS/Linux connection refused
            return "free"
        msg = str(err).lower()
        if "connection refused" in msg or "failed to establish" in msg:
            return "free"
        return "blocked"
    except TimeoutError:
        return "blocked"
    except Exception:
        return "blocked"

    if "json" not in content_type.lower() and raw[:1] not in (b"{", b"["):
        return "blocked"
    try:
        import json

        return json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return "blocked"


def ensure_viewer_daemon(*, probe_only: bool = False) -> bool:
    """Ensure the singleton Hermes Viewer daemon owns :18800.

    Returns True when the MemOS Hermes Viewer is already running or was
    started. Returns False when the port is occupied by another service, Node
    is unavailable, or the daemon did not become healthy quickly. This status
    must not affect stdio memory capture.
    """
    global _viewer_last_probe_at, _viewer_process, _viewer_status
    with _lock:
        now = time.time()
        if (
            probe_only
            and _viewer_status == "running_memos"
            and now - _viewer_last_probe_at < VIEWER_PROBE_TTL_SEC
        ):
            return True

        status = _probe_viewer()
        _viewer_status = status
        _viewer_last_probe_at = now
        if status == "running_memos":
            return True
        if status == "blocked":
            logger.warning(
                "MemOS: viewer port %d is occupied by a non-MemOS service; "
                "memory capture will continue without the web panel",
                HERMES_VIEWER_PORT,
            )
            return False
        if probe_only:
            return False
        with _viewer_start_lock() as lock_acquired:
            status = _probe_viewer()
            _viewer_status = status
            _viewer_last_probe_at = time.time()
            if status == "running_memos":
                return True
            if status == "blocked":
                logger.warning(
                    "MemOS: viewer port %d is occupied by a non-MemOS service; "
                    "memory capture will continue without the web panel",
                    HERMES_VIEWER_PORT,
                )
                return False
            if not lock_acquired:
                logger.warning(
                    "MemOS: timed out waiting for viewer daemon startup lock; "
                    "memory capture will continue without the web panel",
                )
                return False
            if not ensure_bridge_running():
                return False

            plugin_root = _plugin_root()
            logs_dir = plugin_root / "logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            log_file = logs_dir / "daemon-start.log"
            try:
                log_handle = log_file.open("a", encoding="utf-8")
                _viewer_process = subprocess.Popen(
                    _bridge_command(daemon=True),
                    cwd=str(plugin_root),
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    text=True,
                    start_new_session=True,
                )
                log_handle.close()
            except Exception as err:
                with contextlib.suppress(Exception):
                    log_handle.close()  # type: ignore[possibly-undefined]
                logger.warning("MemOS: failed to start viewer daemon — %s", err)
                return False

            deadline = time.time() + 15.0
            while time.time() < deadline:
                if _viewer_process.poll() is not None:
                    logger.warning(
                        "MemOS: viewer daemon exited early with code %s",
                        _viewer_process.returncode,
                    )
                    return False
                status = _probe_viewer()
                _viewer_status = status
                _viewer_last_probe_at = time.time()
                if status == "running_memos":
                    logger.info("MemOS: viewer daemon running on port %d", HERMES_VIEWER_PORT)
                    return True
                if status == "blocked":
                    logger.warning(
                        "MemOS: viewer port %d became occupied by a non-MemOS service",
                        HERMES_VIEWER_PORT,
                    )
                    return False
                time.sleep(0.5)
            logger.warning("MemOS: viewer daemon did not become healthy within 15s")
            return False


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
