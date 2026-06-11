"""JSON-RPC 2.0 over stdio client for the MemOS bridge.

Spawns the packaged bridge subprocess (compiled ``dist/bridge.cjs`` when
available, otherwise the source ``bridge.cts`` through ``tsx``) and communicates
via line-delimited JSON messages on its stdin/stdout. Responses are matched by
``id``. Notifications (events + logs) are forwarded to registered callbacks on a
reader thread.

The client is *blocking* by design — callers wanting async behaviour
should wrap requests in a thread pool.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import shutil
import signal
import subprocess
import threading
import time

from pathlib import Path
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Callable


logger = logging.getLogger(__name__)

HOST_HANDLER_WAIT_SECONDS = 5.0
HEADLESS_REGISTRY_FILENAME = "headless-bridges.json"
HEADLESS_STALE_SECONDS = float(os.environ.get("MEMOS_HEADLESS_BRIDGE_STALE_SEC", "1800"))
HEADLESS_TERMINATE_TIMEOUT_SECONDS = 2.0
HEADLESS_REGISTRY_LOCK_TIMEOUT_SECONDS = 2.0
HEADLESS_REGISTRY_LOCK_STALE_SECONDS = 30.0


def _installed_node_binary(plugin_root: Path) -> str | None:
    marker = plugin_root / ".memos-node-bin"
    try:
        candidate = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return None


def _bridge_script(plugin_root: Path) -> Path:
    compiled = plugin_root / "dist" / "bridge.cjs"
    if compiled.exists():
        return compiled
    return plugin_root / "bridge.cts"


def _headless_registry_path(plugin_root: Path) -> Path:
    return plugin_root / "daemon" / HEADLESS_REGISTRY_FILENAME


def _read_headless_registry(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    bridges = raw.get("bridges") if isinstance(raw, dict) else raw
    if not isinstance(bridges, list):
        return []
    return [entry for entry in bridges if isinstance(entry, dict)]


def _write_headless_registry(path: Path, bridges: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.{time.monotonic_ns()}.tmp"
    )
    tmp.write_text(
        json.dumps({"bridges": bridges}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)


@contextlib.contextmanager
def _headless_registry_lock(
    path: Path,
    timeout: float = HEADLESS_REGISTRY_LOCK_TIMEOUT_SECONDS,
):
    lock_dir = path.with_suffix(path.suffix + ".lock")
    lock_dir.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
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
                stale = time.time() - lock_dir.stat().st_mtime > HEADLESS_REGISTRY_LOCK_STALE_SECONDS
            if stale:
                with contextlib.suppress(Exception):
                    shutil.rmtree(lock_dir)
                continue
            if time.monotonic() >= deadline:
                yield False
                return
            time.sleep(0.05)

    try:
        yield True
    finally:
        if acquired:
            with contextlib.suppress(Exception):
                shutil.rmtree(lock_dir)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _pid_command(pid: int) -> str:
    try:
        out = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "command="],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=1.0,
        )
    except Exception:
        return ""
    return out.strip()


def _is_headless_bridge_command(command: str, agent: str) -> bool:
    if not command:
        return False
    return (
        ("bridge.cjs" in command or "bridge.cts" in command)
        and "--no-viewer" in command
        and f"--agent={agent}" in command
    )


def _terminate_pid(pid: int, timeout: float = HEADLESS_TERMINATE_TIMEOUT_SECONDS) -> None:
    if not _pid_alive(pid):
        return
    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return
        time.sleep(0.05)
    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGKILL)


def _entry_pid(entry: dict[str, Any]) -> int:
    try:
        return int(entry.get("pid") or 0)
    except (TypeError, ValueError):
        return 0


def _entry_parent_pid(entry: dict[str, Any]) -> int:
    try:
        return int(entry.get("parentPid") or 0)
    except (TypeError, ValueError):
        return 0


def _entry_started_at(entry: dict[str, Any]) -> float:
    try:
        return float(entry.get("startedAt") or 0)
    except (TypeError, ValueError):
        return 0.0


def _reap_stale_headless_bridges(plugin_root: Path, agent: str) -> None:
    registry_path = _headless_registry_path(plugin_root)
    with _headless_registry_lock(registry_path) as locked:
        if not locked:
            logger.warning("MemOS: headless bridge registry lock timed out during reap")
            return
        _reap_stale_headless_bridges_locked(registry_path, agent)


def _reap_stale_headless_bridges_locked(registry_path: Path, agent: str) -> None:
    now = time.time()
    keep: list[dict[str, Any]] = []
    changed = False

    for entry in _read_headless_registry(registry_path):
        if entry.get("agent") not in (None, agent):
            keep.append(entry)
            continue

        pid = _entry_pid(entry)
        if not _pid_alive(pid):
            changed = True
            continue

        parent_pid = _entry_parent_pid(entry)
        parent_dead = parent_pid > 0 and not _pid_alive(parent_pid)
        legacy_stale = parent_pid <= 0 and now - _entry_started_at(entry) > HEADLESS_STALE_SECONDS
        if parent_dead or legacy_stale:
            if not _is_headless_bridge_command(_pid_command(pid), agent):
                logger.warning(
                    "MemOS: dropping stale headless bridge registry entry for non-bridge pid=%s",
                    pid,
                )
                changed = True
                continue
            logger.warning("MemOS: reaping stale headless bridge pid=%s", pid)
            _terminate_pid(pid)
            changed = True
            continue

        keep.append(entry)

    if changed:
        _write_headless_registry(registry_path, keep)


def _register_headless_bridge(plugin_root: Path, *, pid: int, agent: str) -> None:
    registry_path = _headless_registry_path(plugin_root)
    with _headless_registry_lock(registry_path) as locked:
        if not locked:
            logger.warning("MemOS: headless bridge registry lock timed out during register")
            return
        _register_headless_bridge_locked(registry_path, pid=pid, agent=agent)


def _register_headless_bridge_locked(registry_path: Path, *, pid: int, agent: str) -> None:
    bridges = [
        entry
        for entry in _read_headless_registry(registry_path)
        if _entry_pid(entry) != pid
    ]
    bridges.append(
        {
            "pid": pid,
            "parentPid": os.getpid(),
            "startedAt": time.time(),
            "agent": agent,
        }
    )
    _write_headless_registry(registry_path, bridges)


def _unregister_headless_bridge(plugin_root: Path, pid: int) -> None:
    registry_path = _headless_registry_path(plugin_root)
    with _headless_registry_lock(registry_path) as locked:
        if not locked:
            logger.warning("MemOS: headless bridge registry lock timed out during unregister")
            return
        _unregister_headless_bridge_locked(registry_path, pid)


def _unregister_headless_bridge_locked(registry_path: Path, pid: int) -> None:
    bridges = _read_headless_registry(registry_path)
    next_bridges = [entry for entry in bridges if _entry_pid(entry) != pid]
    if len(next_bridges) != len(bridges):
        _write_headless_registry(registry_path, next_bridges)


def _best_effort_registry_step(label: str, fn: Callable[[], None]) -> None:
    try:
        fn()
    except Exception as err:
        logger.warning("MemOS: headless bridge registry %s failed: %s", label, err)


class BridgeError(RuntimeError):
    """Raised when the bridge returns a JSON-RPC error object."""

    def __init__(self, code: str, message: str, data: Any = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.data = data


class MemosBridgeClient:
    """Client wrapping a line-delimited JSON-RPC 2.0 stdio bridge.

    Usage:
        >>> client = MemosBridgeClient()
        >>> client.request("core.health", {})
        {'ok': True, 'version': '...'}
        >>> client.close()

    Thread-safe: per-request locking ensures concurrent callers don't
    interleave writes.
    """

    def __init__(
        self,
        *,
        bridge_path: str | None = None,
        node_binary: str | None = None,
        agent: str = "hermes",
        no_viewer: bool = True,
        extra_env: dict[str, str] | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._next_id = 1
        self._pending: dict[int, dict[str, Any]] = {}
        self._events: list[Callable[[dict[str, Any]], None]] = []
        self._logs: list[Callable[[dict[str, Any]], None]] = []
        # Reverse-direction handlers: the bridge can send us a
        # JSON-RPC request via `serverRequest(...)` (e.g.
        # `host.llm.complete` for fallback LLM calls). Registered
        # methods run on the dedicated reader thread; long-running
        # work should spawn its own worker if it needs to. Each
        # handler returns a JSON-serialisable value or raises to
        # surface a JSON-RPC error back to the bridge.
        self._host_handlers: dict[str, Callable[[dict[str, Any]], Any]] = {}
        self._host_handlers_cv = threading.Condition()
        self._closed = False

        plugin_root = Path(__file__).resolve().parent.parent.parent.parent
        self._plugin_root = plugin_root
        self._no_viewer = no_viewer
        node = (
            node_binary
            or os.environ.get("MEMOS_NODE_BINARY")
            or _installed_node_binary(plugin_root)
            or shutil.which("node")
            or "node"
        )
        script_path = Path(bridge_path) if bridge_path else _bridge_script(plugin_root)
        script = str(script_path)
        env = {**os.environ, **(extra_env or {})}
        if no_viewer:
            _best_effort_registry_step(
                "reap",
                lambda: _reap_stale_headless_bridges(plugin_root, agent),
            )

        # Prefer the compiled CommonJS bridge from packaged installs. The raw
        # TypeScript entry remains as a development fallback and needs `tsx`
        # for stripping types plus `.js` → `.ts` import resolution. On Windows
        # the `.bin/tsx` file is a shell shim, so use tsx's real JS entrypoint
        # whenever we have to launch the source entry through a specific Node.
        tsx_cli = plugin_root / "node_modules" / "tsx" / "dist" / "cli.mjs"
        bridge_args = [script, f"--agent={agent}"]
        if no_viewer:
            bridge_args.append("--no-viewer")
        if script_path.suffix == ".cjs":
            cmd = [node, *bridge_args]
        elif tsx_cli.exists():
            cmd = [node, str(tsx_cli), *bridge_args]
        else:
            # Fallback path: `node --import tsx` reproduces the same loader
            # inline. Requires tsx to be resolvable as a package from the
            # plugin root — true whenever node_modules exists. If tsx is
            # genuinely missing the child will fail fast with a loader
            # error the stderr reader will surface.
            cmd = [node, "--import", "tsx", *bridge_args]
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
            cwd=str(plugin_root),
        )
        if no_viewer:
            _best_effort_registry_step(
                "register",
                lambda: _register_headless_bridge(plugin_root, pid=self.pid, agent=agent),
            )
        self._reader = threading.Thread(
            target=self._read_loop,
            daemon=True,
            name="memos-bridge-reader",
        )
        self._reader.start()
        self._stderr_reader = threading.Thread(
            target=self._stderr_loop,
            daemon=True,
            name="memos-bridge-stderr",
        )
        self._stderr_reader.start()

    @property
    def pid(self) -> int:
        """Return the PID of the bridge subprocess."""
        return int(getattr(self._proc, "pid", 0) or 0)

    # ─── Public API ──

    def request(
        self,
        method: str,
        params: Any = None,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        if self._closed:
            raise BridgeError("transport_closed", "bridge client is closed")
        with self._lock:
            rpc_id = self._next_id
            self._next_id += 1
            waiter = threading.Event()
            entry: dict[str, Any] = {"event": waiter, "result": None, "error": None}
            self._pending[rpc_id] = entry
            payload = json.dumps(
                {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params},
                ensure_ascii=False,
            )
            try:
                self._proc.stdin.write(payload + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as err:
                self._pending.pop(rpc_id, None)
                raise BridgeError("transport_closed", str(err)) from err

        if not waiter.wait(timeout=timeout):
            with self._lock:
                self._pending.pop(rpc_id, None)
            raise BridgeError("timeout", f"{method} did not respond within {timeout}s")
        if entry["error"] is not None:
            e = entry["error"]
            raise BridgeError(
                e.get("data", {}).get("code") or str(e.get("code", "internal")),
                e.get("message", "unknown error"),
                e.get("data"),
            )
        return entry["result"] or {}

    def notify(self, method: str, params: Any = None) -> None:
        if self._closed:
            return
        with self._lock:
            payload = json.dumps({"jsonrpc": "2.0", "method": method, "params": params})
            try:
                self._proc.stdin.write(payload + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

    def on_event(self, cb: Callable[[dict[str, Any]], None]) -> None:
        self._events.append(cb)

    def on_log(self, cb: Callable[[dict[str, Any]], None]) -> None:
        self._logs.append(cb)

    def register_host_handler(
        self,
        method: str,
        handler: Callable[[dict[str, Any]], Any],
    ) -> None:
        """Register a handler for bridge → adapter (reverse) requests.

        The Node-side bridge calls these via ``stdio.serverRequest``.
        Most-recent registration wins. The handler runs on the reader
        thread; if it blocks for a long time it stalls every other
        bridge → adapter notification, so handlers that need to do
        heavy work (e.g. an LLM call) are still expected to return
        within the bridge-side timeout (default 60 s).
        """
        with self._host_handlers_cv:
            self._host_handlers[method] = handler
            self._host_handlers_cv.notify_all()

    def close(self) -> None:
        if self._closed:
            return
        with self._host_handlers_cv:
            self._closed = True
            self._host_handlers_cv.notify_all()

        pid = self.pid

        # 1. Close stdin (triggers bridge's graceful exit)
        with contextlib.suppress(Exception):
            self._proc.stdin.close()

        # 2. Wait for process to exit gracefully (up to 5 seconds)
        try:
            self._proc.wait(timeout=5.0)
            logger.debug("MemOS: bridge process %d exited gracefully", pid)
        except subprocess.TimeoutExpired:
            # 3. If still running, send SIGTERM
            logger.warning(
                "MemOS: bridge process %d did not exit after stdin close, sending SIGTERM", pid
            )
            try:
                self._proc.terminate()  # Send SIGTERM
                self._proc.wait(timeout=5.0)  # Increased from 2.0 to 5.0 for viewer cleanup
                logger.debug("MemOS: bridge process %d terminated", pid)
            except subprocess.TimeoutExpired:
                # 4. Last resort: SIGKILL
                logger.error(
                    "MemOS: bridge process %d did not respond to SIGTERM, sending SIGKILL", pid
                )
                self._proc.kill()  # Send SIGKILL
                try:
                    self._proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    logger.error("MemOS: bridge process %d could not be killed", pid)

        # 5. Clean up pending requests
        with self._lock:
            for entry in list(self._pending.values()):
                entry["error"] = {
                    "code": -32000,
                    "message": "bridge closed",
                    "data": {"code": "transport_closed"},
                }
                entry["event"].set()
            self._pending.clear()

        if self._no_viewer:
            _best_effort_registry_step(
                "unregister",
                lambda: _unregister_headless_bridge(self._plugin_root, pid),
            )

    # ─── Internals ──

    def _read_loop(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                logger.debug("bridge: malformed line: %r", line[:120])
                continue
            if "id" in msg and msg["id"] is not None and ("result" in msg or "error" in msg):
                self._resolve(msg)
                continue
            if msg.get("method") == "events.notify":
                for cb in list(self._events):
                    try:
                        cb(msg.get("params") or {})
                    except Exception:
                        logger.debug("event listener threw", exc_info=True)
                continue
            if msg.get("method") == "logs.forward":
                for cb in list(self._logs):
                    try:
                        cb(msg.get("params") or {})
                    except Exception:
                        logger.debug("log listener threw", exc_info=True)
                continue
            # Reverse-direction request: the bridge is asking the
            # adapter to do something (e.g. run a fallback LLM call
            # via `host.llm.complete`). Dispatch to the registered
            # handler and write the response back synchronously.
            method = msg.get("method")
            rpc_id = msg.get("id")
            if (
                isinstance(method, str)
                and rpc_id is not None
                and "result" not in msg
                and "error" not in msg
            ):
                handler = self._host_handler_for(method)
                if handler is None:
                    self._send_response(
                        rpc_id,
                        error={
                            "code": -32601,
                            "message": f"method not found: {method}",
                            "data": {"code": "unknown_method"},
                        },
                    )
                    continue
                params = msg.get("params") or {}
                if not isinstance(params, dict):
                    params = {}
                try:
                    result = handler(params)
                    self._send_response(rpc_id, result=result)
                except Exception as err:
                    logger.warning("host handler %s failed: %s", method, err)
                    self._send_response(
                        rpc_id,
                        error={
                            "code": -32000,
                            "message": str(err) or err.__class__.__name__,
                            "data": {"code": "host_handler_failed"},
                        },
                    )
                continue

    def _host_handler_for(
        self,
        method: str,
        *,
        timeout: float = HOST_HANDLER_WAIT_SECONDS,
    ) -> Callable[[dict[str, Any]], Any] | None:
        """Return a reverse-RPC handler, waiting briefly during startup.

        The Node bridge now starts stdio before ``core.init()`` so host LLM
        fallback can run during startup recovery. On a fast machine that
        reverse request can arrive just before ``initialize()`` registers
        ``host.llm.complete``. Waiting here turns that sub-millisecond race
        into the intended handshake while still returning ``unknown_method``
        for genuinely unsupported methods.
        """
        with self._host_handlers_cv:
            self._host_handlers_cv.wait_for(
                lambda: method in self._host_handlers or self._closed,
                timeout=timeout,
            )
            return self._host_handlers.get(method)

    def _send_response(
        self,
        rpc_id: Any,
        *,
        result: Any = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        """Write a JSON-RPC response for a reverse-direction request."""
        if self._closed:
            return
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": rpc_id}
        if error is not None:
            payload["error"] = error
        else:
            payload["result"] = result
        with self._lock:
            try:
                self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

    def _stderr_loop(self) -> None:
        assert self._proc.stderr is not None
        for line in self._proc.stderr:
            line = line.rstrip()
            if line:
                logger.debug("bridge.stderr: %s", line)

    def _resolve(self, msg: dict[str, Any]) -> None:
        rpc_id = msg.get("id")
        if not isinstance(rpc_id, int):
            return
        with self._lock:
            entry = self._pending.pop(rpc_id, None)
        if not entry:
            return
        if "error" in msg:
            entry["error"] = msg["error"]
        else:
            entry["result"] = msg.get("result")
        entry["event"].set()
