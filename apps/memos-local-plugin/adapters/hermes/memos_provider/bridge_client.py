"""JSON-RPC 2.0 over stdio client for the MemOS bridge.

Spawns ``node bridge.cts --agent=hermes`` as a subprocess and communicates
via line-delimited JSON messages on its stdin/stdout. Responses are
matched by ``id``. Notifications (events + logs) are forwarded to
registered callbacks on a reader thread.

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


def _installed_node_binary(plugin_root: Path) -> str | None:
    marker = plugin_root / ".memos-node-bin"
    try:
        candidate = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return None


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
        self._closed = False

        plugin_root = Path(__file__).resolve().parent.parent.parent.parent
        node = (
            node_binary
            or os.environ.get("MEMOS_NODE_BINARY")
            or _installed_node_binary(plugin_root)
            or shutil.which("node")
            or "node"
        )
        script = bridge_path or str(plugin_root / "bridge.cts")
        env = {**os.environ, **(extra_env or {})}

        # The plugin ships raw TypeScript (no precompiled `dist/`). Node's
        # own `--experimental-strip-types` strips type annotations but does
        # not rewrite `.js` import specifiers to the corresponding `.ts`
        # files on disk — and the source tree uses `.js` extensions in
        # every import per the TSC / bundler convention. We therefore
        # launch the bridge via the bundled `tsx` binary, which handles
        # both jobs (strip types + extension rewrite). `tsx` is declared
        # as a production dependency in package.json so it's always present
        # under node_modules/.bin after `npm install`.
        tsx_bin = plugin_root / "node_modules" / ".bin" / "tsx"
        if tsx_bin.exists():
            cmd = [node, str(tsx_bin), script, f"--agent={agent}"]
        else:
            # Fallback path: `node --import tsx` reproduces the same loader
            # inline. Requires tsx to be resolvable as a package from the
            # plugin root — true whenever node_modules exists. If tsx is
            # genuinely missing the child will fail fast with a loader
            # error the stderr reader will surface.
            cmd = [node, "--import", "tsx", script, f"--agent={agent}"]
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
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
        self._host_handlers[method] = handler

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            self._proc.stdin.close()
        # DON'T wait() or kill() the bridge process. If it has an
        # active viewer (HTTP server), it will stay alive as a daemon
        # so the memory panel remains accessible between `hermes chat`
        # sessions. If it's headless (viewer port was taken), it will
        # notice stdin EOF and exit on its own.
        # unblock any pending waiters
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
                handler = self._host_handlers.get(method)
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
