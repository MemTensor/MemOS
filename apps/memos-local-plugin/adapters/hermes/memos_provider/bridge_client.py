"""JSON-RPC 2.0 client for the MemOS bridge.

Two transport modes:
- **TCP** (preferred): connects to an existing daemon bridge via
  ``host:port``.  Hermes CLI exits without disrupting the daemon's
  session — episodes finalize properly.
- **stdio** (fallback): spawns ``node bridge.cts --agent=hermes`` as a
  subprocess and communicates via line-delimited JSON on stdin/stdout.

Responses are matched by ``id``. Notifications (events + logs) are
forwarded to registered callbacks on a reader thread. Thread-safe.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import socket as _socket
import shutil
import subprocess
import threading

from pathlib import Path
from typing import TYPE_CHECKING, Any

from daemon_manager import kill_existing_bridge, register_bridge


if TYPE_CHECKING:
    from collections.abc import Callable


logger = logging.getLogger(__name__)

DEFAULT_TCP_HOST = "127.0.0.1"
DEFAULT_TCP_PORT = 18911


class BridgeError(RuntimeError):
    """Raised when the bridge returns a JSON-RPC error object."""

    def __init__(self, code: str, message: str, data: Any = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.data = data


class _SocketTransport:
    """TCP socket wrapper with line-delimited JSON read/write."""

    def __init__(self, host: str, port: int) -> None:
        self._sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        self._sock.settimeout(15.0)
        self._sock.connect((host, port))
        self._sock.settimeout(None)
        self._rfile = self._sock.makefile("r", buffering=1, encoding="utf-8")

    def write_line(self, text: str) -> None:
        payload = text if text.endswith("\n") else text + "\n"
        self._sock.sendall(payload.encode("utf-8"))

    def read_line(self) -> str | None:
        line = self._rfile.readline()
        return line if line else None

    def close(self) -> None:
        try:
            self._sock.shutdown(_socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self._rfile.close()
        except Exception:
            pass
        self._sock.close()


class MemosBridgeClient:
    """Client wrapping a line-delimited JSON-RPC 2.0 bridge.

    By default attempts TCP connection to an existing daemon bridge at
    ``127.0.0.1:18911``. On failure falls back to spawning a stdio
    subprocess — transparent to callers.

    Usage:
        >>> client = MemosBridgeClient()
        >>> client.request("core.health", {})
        {'ok': True, 'version': '...'}
        >>> client.close()
    """

    def __init__(
        self,
        *,
        prefer_tcp: bool = True,
        tcp_host: str = DEFAULT_TCP_HOST,
        tcp_port: int = DEFAULT_TCP_PORT,
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
        self._transport: _SocketTransport | None = None

        # ── TCP mode ─────────────────────────────────────────────────
        if prefer_tcp:
            try:
                self._transport = _SocketTransport(tcp_host, tcp_port)
                self._reader = threading.Thread(
                    target=self._read_loop_tcp,
                    daemon=True,
                    name="memos-bridge-tcp-reader",
                )
                self._reader.start()
                logger.info(
                    "MemosBridgeClient: connected via TCP (%s:%d)",
                    tcp_host, tcp_port,
                )
                return
            except (ConnectionRefusedError, OSError) as exc:
                logger.info(
                    "MemosBridgeClient: TCP connect failed (%s), falling back to stdio",
                    exc,
                )

        # ── stdio mode ───────────────────────────────────────────────
        node = node_binary or shutil.which("node") or "node"
        script = bridge_path or str(
            Path(__file__).resolve().parent.parent.parent.parent / "bridge.cts"
        )
        env = {**os.environ, **(extra_env or {})}
        kill_existing_bridge()
        self._proc = subprocess.Popen(
            [node, "--experimental-strip-types", script, f"--agent={agent}"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        register_bridge(self._proc)
        self._reader = threading.Thread(
            target=self._read_loop_stdio,
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

    # ─── Public API ──────────────────────────────────────────────────

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
            self._write_or_raise(payload + "\n")

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
                self._write_text(payload + "\n")
            except (BrokenPipeError, OSError, ConnectionError):
                pass

    def on_event(self, cb: Callable[[dict[str, Any]], None]) -> None:
        self._events.append(cb)

    def on_log(self, cb: Callable[[dict[str, Any]], None]) -> None:
        self._logs.append(cb)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._transport is not None:
            self._transport.close()
            self._transport = None
        else:
            with contextlib.suppress(Exception):
                self._proc.stdin.close()
            try:
                self._proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            register_bridge(None)
        with self._lock:
            for entry in list(self._pending.values()):
                entry["error"] = {
                    "code": -32000,
                    "message": "bridge closed",
                    "data": {"code": "transport_closed"},
                }
                entry["event"].set()
            self._pending.clear()

    # ─── Internals: write helpers ────────────────────────────────────

    def _write_or_raise(self, text: str) -> None:
        if self._transport is not None:
            try:
                self._transport.write_line(text)
            except (BrokenPipeError, OSError, ConnectionError) as err:
                raise BridgeError("transport_closed", str(err)) from err
        else:
            assert self._proc.stdin is not None
            try:
                self._proc.stdin.write(text)
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as err:
                raise BridgeError("transport_closed", str(err)) from err

    def _write_text(self, text: str) -> None:
        try:
            if self._transport is not None:
                self._transport.write_line(text)
            else:
                assert self._proc.stdin is not None
                self._proc.stdin.write(text)
                self._proc.stdin.flush()
        except (BrokenPipeError, OSError, ConnectionError):
            pass

    # ─── Internals: read loops ───────────────────────────────────────

    def _read_loop_tcp(self) -> None:
        transport = self._transport
        if transport is None:
            return
        while not self._closed:
            try:
                line = transport.read_line()
            except (OSError, ConnectionError):
                if not self._closed:
                    logger.error("bridge_client: TCP read error, reader exiting")
                break
            if line is None:
                if not self._closed:
                    logger.warning("bridge_client: TCP connection closed by peer")
                break
            self._dispatch(line)

    def _read_loop_stdio(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            if self._closed:
                break
            self._dispatch(line)

    def _stderr_loop(self) -> None:
        assert self._proc.stderr is not None
        for line in self._proc.stderr:
            line = line.rstrip()
            if line:
                logger.debug("bridge.stderr: %s", line)

    # ─── Common dispatch ─────────────────────────────────────────────

    def _dispatch(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            logger.debug("bridge: malformed line: %r", line[:120])
            return
        if "id" in msg and msg["id"] is not None and ("result" in msg or "error" in msg):
            self._resolve(msg)
            return
        if msg.get("method") == "events.notify":
            for cb in list(self._events):
                try:
                    cb(msg.get("params") or {})
                except Exception:
                    logger.debug("event listener threw", exc_info=True)
            return
        if msg.get("method") == "logs.forward":
            for cb in list(self._logs):
                try:
                    cb(msg.get("params") or {})
                except Exception:
                    logger.debug("log listener threw", exc_info=True)
            return

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
