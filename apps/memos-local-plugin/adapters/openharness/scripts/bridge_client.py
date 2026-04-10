"""Python client for memos-core-bridge.

Supports two connection modes:
  1. TCP (daemon mode) — connects to a running bridge daemon, preferred.
  2. stdio (subprocess) — spawns a short-lived bridge child process, fallback.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import socket
import subprocess
import threading

from typing import Any

from config import _get_plugin_root, find_bridge_script, get_bridge_config, get_daemon_port


logger = logging.getLogger(__name__)


class _TcpTransport:
    """JSON-RPC over TCP to the bridge daemon."""

    def __init__(self, port: int, timeout: float = 120.0) -> None:
        self._port = port
        self._timeout = timeout
        self._sock: socket.socket | None = None
        self._buffer = b""
        self._connect()

    def _connect(self) -> None:
        self._sock = socket.create_connection(("127.0.0.1", self._port), timeout=self._timeout)
        self._sock.settimeout(self._timeout)

    def send(self, data: str) -> str:
        assert self._sock is not None
        self._sock.sendall((data + "\n").encode())
        while b"\n" not in self._buffer:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise RuntimeError("Daemon closed connection")
            self._buffer += chunk
        line, self._buffer = self._buffer.split(b"\n", 1)
        return line.decode("utf-8")

    def close(self) -> None:
        if self._sock:
            with contextlib.suppress(OSError):
                self._sock.close()
            self._sock = None


class _StdioTransport:
    """JSON-RPC over stdin/stdout to a child bridge process."""

    def __init__(self) -> None:
        bridge_cmd = find_bridge_script()
        env = {**os.environ}
        env["MEMOS_BRIDGE_CONFIG"] = json.dumps(get_bridge_config())

        logger.info("Starting bridge subprocess: %s", " ".join(bridge_cmd))
        self._proc = subprocess.Popen(
            bridge_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(_get_plugin_root()),
        )
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        assert self._proc.stderr is not None
        for raw_line in self._proc.stderr:
            line = raw_line.decode("utf-8", errors="replace").rstrip()
            if line:
                logger.debug("[bridge] %s", line)

    def send(self, data: str) -> str:
        assert self._proc.stdin is not None
        assert self._proc.stdout is not None
        self._proc.stdin.write((data + "\n").encode())
        self._proc.stdin.flush()
        line = self._proc.stdout.readline().decode("utf-8").strip()
        if not line:
            raise RuntimeError("Bridge process closed stdout unexpectedly")
        return line

    def close(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.terminate()
            self._proc.wait(timeout=5)
        except Exception:
            self._proc.kill()


class MemosCoreBridge:
    """Communicate with the memos-core bridge. Auto-selects TCP or stdio."""

    def __init__(self, *, force_stdio: bool = False) -> None:
        self._id = 0
        self._lock = threading.Lock()
        self._transport: _TcpTransport | _StdioTransport

        if not force_stdio:
            port = get_daemon_port()
            try:
                t = _TcpTransport(port, timeout=120.0)
                # Quick ping to verify connection
                self._transport = t
                self._id = 0
                result = self.call("ping")
                if result.get("pong"):
                    logger.info("Connected to daemon on port %d", port)
                    return
                else:
                    t.close()
            except Exception as e:
                logger.debug("Daemon not available on port %d: %s", port, e)

        logger.info("Falling back to stdio bridge subprocess")
        self._transport = _StdioTransport()

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send a JSON-RPC request and return the result."""
        with self._lock:
            self._id += 1
            req = json.dumps({"id": self._id, "method": method, "params": params or {}})
            line = self._transport.send(req)
            resp = json.loads(line)
            if "error" in resp:
                raise RuntimeError(f"Bridge error: {resp['error']}")
            return resp.get("result", {})

    def search(
        self, query: str, max_results: int = 6, min_score: float = 0.45, owner: str = "openharness"
    ) -> dict:
        return self.call(
            "search",
            {
                "query": query,
                "maxResults": max_results,
                "minScore": min_score,
                "owner": owner,
            },
        )

    def ingest(
        self, messages: list[dict], session_id: str = "default", owner: str | None = None
    ) -> None:
        params: dict[str, Any] = {"messages": messages, "sessionId": session_id}
        if owner:
            params["owner"] = owner
        self.call("ingest", params)

    def build_prompt(self, query: str, max_results: int = 6, owner: str = "openharness") -> dict:
        return self.call(
            "build_prompt", {"query": query, "maxResults": max_results, "owner": owner}
        )

    def flush(self) -> None:
        self.call("flush")

    def ping(self) -> bool:
        try:
            result = self.call("ping")
            return result.get("pong", False)
        except Exception:
            return False

    def recent(self, limit: int = 20, owner: str = "openharness") -> dict:
        """Get the most recent memories ordered by time (no semantic search)."""
        return self.call("recent", {"limit": limit, "owner": owner})

    def get_viewer_url(self) -> str:
        """Get the viewer URL from the daemon. Only works in TCP mode."""
        try:
            result = self.call("get_viewer_url")
            return result.get("url", "")
        except Exception:
            return ""

    def shutdown(self) -> None:
        """Close the connection. Does NOT stop the daemon."""
        self._transport.close()
