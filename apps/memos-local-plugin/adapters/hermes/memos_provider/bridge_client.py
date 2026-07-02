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
import subprocess
import threading

from pathlib import Path
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Callable


logger = logging.getLogger(__name__)

HOST_HANDLER_WAIT_SECONDS = 5.0

# ─── Module-level singleton tracker ─────────────────────────────────────
# Each entry maps a ``(agent, no_viewer)`` key to the most-recent active
# ``MemosBridgeClient`` for that slot. When a new client is constructed
# for an existing key, the previous client is closed synchronously so the
# Node-side ``bridge.cjs`` subprocess does not leak.
#
# This is the Python-side guard against issue #1910 (bridge process leak:
# every turn spawns new bridge.cjs). Defence in depth on the Node side
# lives in ``bridge.cts`` via ``bridge-stdio.pid``.
_ACTIVE_CLIENTS: dict[tuple[str, bool], MemosBridgeClient] = {}
_ACTIVE_CLIENTS_LOCK = threading.Lock()


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
    """Pick the bridge entrypoint, preferring pure ESM over the CJS trampoline.

    Resolution order (issue #1736):
        1. ``dist/bridge.mjs`` — pure ESM compiled output, the only entry
           that avoids the CJS↔ESM bridge that fails on Node ≥ 22.
        2. ``dist/bridge.cjs`` — legacy CommonJS compiled output, kept for
           installations whose ``dist/`` predates the ESM entrypoint.
        3. ``bridge.mts`` — pure ESM TypeScript source for ``tsx``-driven
           local development.
        4. ``bridge.cts`` — legacy CommonJS TypeScript source. Returned
           as the last-resort default so error messages stay stable when
           none of the candidates exist.
    """
    candidates = (
        plugin_root / "dist" / "bridge.mjs",
        plugin_root / "dist" / "bridge.cjs",
        plugin_root / "bridge.mts",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return plugin_root / "bridge.cts"


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

        # Prefer the compiled JavaScript bridge — the new pure ESM
        # ``dist/bridge.mjs`` (issue #1736) or the legacy ``dist/bridge.cjs``
        # — both run on plain ``node`` without any loader. The raw
        # TypeScript entries remain as a development fallback and need
        # ``tsx`` for stripping types plus ``.js`` → ``.ts`` import
        # resolution. On Windows the ``.bin/tsx`` file is a shell shim,
        # so use tsx's real JS entrypoint whenever we have to launch the
        # source entry through a specific Node.
        tsx_cli = plugin_root / "node_modules" / "tsx" / "dist" / "cli.mjs"
        bridge_args = [script, f"--agent={agent}"]
        if no_viewer:
            bridge_args.append("--no-viewer")
        if script_path.suffix in (".mjs", ".cjs"):
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

        # Singleton tracking (issue #1910). Register ourselves as the
        # active client for ``(agent, no_viewer)`` and reap any previous
        # holder synchronously so its subprocess does not leak. The reap
        # happens AFTER our reader threads are running, so the previous
        # client's ``close()`` (which closes stdin and waits for exit)
        # cannot interfere with our own startup.
        self._singleton_agent = agent
        self._singleton_no_viewer = bool(no_viewer)
        previous = self._register_active()
        if previous is not None and previous is not self:
            prev_pid = getattr(previous, "pid", "?")
            logger.info(
                "MemOS: closing previous bridge client (pid=%s) before adopting new one (pid=%s)",
                prev_pid,
                self.pid,
            )
            with contextlib.suppress(Exception):
                previous.close()

    def _register_active(self) -> MemosBridgeClient | None:
        """Register self as the active singleton; return the displaced client."""
        key = (self._singleton_agent, self._singleton_no_viewer)
        with _ACTIVE_CLIENTS_LOCK:
            previous = _ACTIVE_CLIENTS.get(key)
            _ACTIVE_CLIENTS[key] = self
        return previous

    def _unregister_active(self) -> None:
        """Remove self from the active registry if we are still the current entry."""
        key = (self._singleton_agent, self._singleton_no_viewer)
        with _ACTIVE_CLIENTS_LOCK:
            if _ACTIVE_CLIENTS.get(key) is self:
                _ACTIVE_CLIENTS.pop(key, None)

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

        # Drop self from the module-level singleton tracker (issue #1910)
        # BEFORE the potentially-slow stdin/SIGTERM/SIGKILL dance. We
        # only evict the registry slot if we still own it — a newer
        # client that displaced us must remain reachable.
        self._unregister_active()

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
