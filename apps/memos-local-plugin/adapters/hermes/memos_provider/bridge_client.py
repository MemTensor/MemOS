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
        self._closed = False

        node = node_binary or shutil.which("node") or "node"
        script = bridge_path or str(
            Path(__file__).resolve().parent.parent.parent.parent / "bridge.cts"
        )
        env = {**os.environ, **(extra_env or {})}
        self._proc = subprocess.Popen(
            [node, "--experimental-strip-types", script, f"--agent={agent}"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
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

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            self._proc.stdin.close()
        try:
            self._proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            self._proc.kill()
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
