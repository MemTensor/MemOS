"""Gateway integration manager for Hermes Agent.

Provides an async-friendly interface for Hermes's GatewayRunner to manage
the MemOS bridge process lifecycle: start, heartbeat, stop.

Usage in Hermes:
    from adapters.hermes.memos_provider.gateway_manager import GatewayMemosManager

    manager = GatewayMemosManager()
    manager.ensure_running()         # start or confirm bridge is alive
    await manager.start_heartbeat()  # background health check
    ...
    await manager.stop_heartbeat()
    manager.shutdown()               # kill bridge
"""

from __future__ import annotations

import asyncio
import logging

from adapters.hermes.memos_provider.daemon_manager import ensure_bridge_running, shutdown_bridge

logger = logging.getLogger(__name__)


class GatewayMemosManager:
    """Async manager for the MemOS bridge subprocess.

    This class is designed to be imported and used by Hermes' GatewayRunner.
    It provides async lifecycle methods that wrap the synchronous
    ``daemon_manager`` module, which handles PID files and subprocess
    management under the hood.

    Thread safety: Delegated to ``daemon_manager`` (uses its own lock).
    """

    def __init__(self) -> None:
        self._heartbeat_task: asyncio.Task | None = None
        self._heartbeat_interval: float = 30.0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def ensure_running(self) -> bool:
        """Start (or confirm) the bridge daemon is operational.

        Safe to call repeatedly — idempotent. Returns True when the
        bridge is (or was made) operational, False otherwise.
        """
        return ensure_bridge_running()

    async def start_heartbeat(self, interval: float | None = None) -> None:
        """Start a background loop that probes the bridge periodically.

        The heartbeat calls ``ensure_running()`` every *interval* seconds.
        It only checks the local PID file — no network traffic.

        Safe to call multiple times (second call is a no-op).
        """
        if self._heartbeat_task is not None:
            logger.debug("GatewayMemosManager: heartbeat already running")
            return
        if interval is not None:
            self._heartbeat_interval = interval
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info(
            "GatewayMemosManager: heartbeat started (interval=%ss)",
            self._heartbeat_interval,
        )

    async def stop_heartbeat(self) -> None:
        """Cancel the heartbeat loop and wait for it to finish."""
        task, self._heartbeat_task = self._heartbeat_task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.debug("GatewayMemosManager: heartbeat stopped")

    def shutdown(self) -> None:
        """Gracefully shut down the bridge subprocess.

        Sends SIGTERM, waits up to 5s, then escalates to SIGKILL if
        the process hasn't exited. Cleans up the PID file.
        """
        shutdown_bridge()
        logger.info("GatewayMemosManager: bridge daemon shut down")

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _heartbeat_loop(self) -> None:
        """Periodic health check loop."""
        try:
            while True:
                await asyncio.sleep(self._heartbeat_interval)
                try:
                    self.ensure_running()
                except Exception:
                    logger.exception(
                        "GatewayMemosManager: ensure_running in heartbeat failed"
                    )
        except asyncio.CancelledError:
            pass
