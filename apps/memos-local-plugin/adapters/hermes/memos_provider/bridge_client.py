"""JSON-RPC 2.0 client for the MemOS bridge.

Two transport modes:
- **TCP** (recommended): connects to an existing daemon bridge via ``host:port``.
  Hermes CLI exits without disrupting the daemon's session → episodes finalize properly.
- **stdio** (fallback): spawns ``node bridge.cts --agent=hermes`` as a subprocess.

Responses are matched by ``id``. Notifications (events + logs) are forwarded to
registered callbacks on a reader thread. Thread-safe.
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
import time

from pathlib import Path
from typing import TYPE_CHECKING, Any

# Ensure at-most-one bridge instance via PID file (stdio mode only).
from daemon_manager import kill_existing_bridge, register_bridge


if TYPE_CHECKING:
    from collections.abc import Callable


logger = logging.getLogger(__name__)

DEFAULT_TCP_HOST = "127.0.0.1"
DEFAULT_TCP_PORT = 18911
_TCP_RECONNECT_DELAY = 1.0  # seconds between reconnection attempts
_TCP_MAX_RECONNECT = 3


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
        self._sock.settimeout(None)  # blocking reads after connect
        self._rfile = self._sock.makefile("r", buffering=1, encoding="utf-8")

    def write_line(self, text: str) -> None:
        # Avoid double newline: callers may or may not include \n.
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
        self._sock.close()


class MemosBridgeClient:
    """Client wrapping a line-delimited JSON-RPC 2.0 bridge.

    Two transport modes:

    **TCP mode** (``tcp_host`` + ``tcp_port`` given):
        Connects to an existing daemon bridge process.  The Hermes CLI can exit
        without closing the daemon's session, so episodes get *finalized* by the
        pipeline rather than *abandoned*.  On connection loss the client tries to
        reconnect a few times.

    **stdio mode** (default):
        Spawns ``node bridge.cts --agent=hermes`` as a subprocess and communicates
        over its stdin / stdout.  The Hermes CLI exiting causes the episode to be
        abandoned.

    Usage:
        >>> client = MemosBridgeClient()
        >>> client.request("core.health", {})
        {'ok': True, 'version': '...'}
        >>> client.close()
    """

    def __init__(
        self,
        *,
        bridge_path: str | None = None,
        node_binary: str | None = None,
        agent: str = "hermes",
        extra_env: dict[str, str] | None = None,
        tcp_host: str | None = None,
        tcp_port: int | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._next_id = 1
        self._pending: dict[int, dict[str, Any]] = {}
        self._events: list[Callable[[dict[str, Any]], None]] = []
        self._logs: list[Callable[[dict[str, Any]], None]] = []
        self._closed = False
        self._tcp_mode = tcp_host is not None or tcp_port is not None

        if self._tcp_mode:
            self._tcp_host = tcp_host or DEFAULT_TCP_HOST
            self._tcp_port = tcp_port or DEFAULT_TCP_PORT
            self._transport: _SocketTransport | None = None
            self._connect_tcp()
        else:
            # ── stdio mode (original behaviour, spawn subprocess) ──
            node = node_binary or shutil.which("node") or "node"
            script = bridge_path or str(
                Path(__file__).resolve().parent.parent.parent.parent / "bridge.cts"
            )
            tsx_bin = str(
                Path(__file__).resolve().parent.parent.parent.parent / "node_modules" / ".bin" / "tsx"
            )
            runtime = tsx_bin if Path(tsx_bin).exists() else node
            runtime_args = [] if Path(tsx_bin).exists() else ["--experimental-strip-types"]
            env = {**os.environ, **(extra_env or {})}
            # Kill any previously-running bridge before spawning a new one.
            kill_existing_bridge()
            self._proc = subprocess.Popen(
                [runtime, *runtime_args, script, f"--agent={agent}"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=env,
            )
            # Register the new process so daemon_manager can track it.
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

    # ── TCP connection helpers ──────────────────────────────────────

    def _connect_tcp(self) -> None:
        """Connect (or reconnect) to the daemon bridge TCP port."""
        last_err = None
        for attempt in range(_TCP_MAX_RECONNECT):
            try:
                self._transport = _SocketTransport(self._tcp_host, self._tcp_port)
                # Start reader thread
                self._reader = threading.Thread(
                    target=self._read_loop_tcp,
                    daemon=True,
                    name="memos-bridge-tcp-reader",
                )
                self._reader.start()
                logger.info(
                    "bridge_client: connected to daemon at %s:%s",
                    self._tcp_host, self._tcp_port,
                )
                return
            except (ConnectionRefusedError, OSError) as e:
                last_err = e
                if attempt < _TCP_MAX_RECONNECT - 1:
                    time.sleep(_TCP_RECONNECT_DELAY * (attempt + 1))
        raise BridgeError(
            "tcp_connect_failed",
            f"Could not connect to daemon bridge at {self._tcp_host}:{self._tcp_port} "
            f"after {_TCP_MAX_RECONNECT} attempts: {last_err}",
        )

    def _reconnect_tcp(self) -> None:
        """Attempt transparent reconnection after transport loss."""
        logger.warning("bridge_client: TCP transport lost, reconnecting…")
        old = self._transport
        self._transport = None
        if old is not None:
            with contextlib.suppress(Exception):
                old.close()
        self._connect_tcp()
        # Re-send session greetings so the daemon knows this client is alive.
        # The daemon treats a new TCP connection as a new client — no session
        # creation needed on the daemon side (it already has its own session).

    # ── Public API ──────────────────────────────────────────────────

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
        if self._tcp_mode:
            self._close_tcp()
        else:
            self._close_stdio()
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

    # ── Internals: write helpers ────────────────────────────────────

    def _write_or_raise(self, text: str) -> None:
        """Write *text* to the transport; raise on failure."""
        if self._tcp_mode:
            if self._transport is None:
                raise BridgeError("transport_closed", "TCP transport disconnected")
            try:
                self._transport.write_line(text)
            except (BrokenPipeError, OSError, ConnectionError) as err:
                # Attempt transparent reconnect
                try:
                    self._reconnect_tcp()
                    self._transport.write_line(text)
                except Exception as reconnect_err:
                    raise BridgeError("transport_closed", str(reconnect_err)) from err
        else:
            assert self._proc.stdin is not None
            try:
                self._proc.stdin.write(text)
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as err:
                raise BridgeError("transport_closed", str(err)) from err

    def _write_text(self, text: str) -> None:
        """Best-effort write, swallow errors."""
        try:
            if self._tcp_mode:
                if self._transport is not None:
                    self._transport.write_line(text)
            else:
                assert self._proc.stdin is not None
                self._proc.stdin.write(text)
                self._proc.stdin.flush()
        except (BrokenPipeError, OSError, ConnectionError):
            pass

    # ── Internals: close ────────────────────────────────────────────

    def _close_tcp(self) -> None:
        if self._transport is not None:
            self._transport.close()
            self._transport = None

    def _close_stdio(self) -> None:
        with contextlib.suppress(Exception):
            self._proc.stdin.close()
        try:
            self._proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        # Clear PID file so a future incarnation starts fresh.
        register_bridge(None)

    # ── Internals: read loops ───────────────────────────────────────

    def _read_loop_tcp(self) -> None:
        """Read line-delimited JSON from the TCP socket."""
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
            line = line.strip()
            if not line:
                continue
            self._dispatch(line)
        # If the socket died but the client isn't closed, try a reconnect
        # in the background.  The next request() call will also trigger
        # reconnection via _write_or_raise.
        if not self._closed and self._transport is not None:
            logger.info("bridge_client: TCP reader lost; will reconnect on next request")

    def _read_loop_stdio(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            self._dispatch(line)

    def _stderr_loop(self) -> None:
        assert self._proc.stderr is not None
        for line in self._proc.stderr:
            line = line.rstrip()
            if line:
                logger.debug("bridge.stderr: %s", line)

    # ── Common dispatch ─────────────────────────────────────────────

    def _dispatch(self, line: str) -> None:
        """Parse a JSON-RPC line and route it to the right handler."""
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
