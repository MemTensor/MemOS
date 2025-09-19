import threading
import time

from datetime import datetime
from time import perf_counter

from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.general_modules.dispatcher import SchedulerDispatcher


logger = get_logger(__name__)


class SchedulerDispatcherMonitor(BaseSchedulerModule):
    """Monitors and manages scheduling operations with LLM integration."""

    def __init__(self, config: BaseSchedulerConfig):
        super().__init__()
        self.config: BaseSchedulerConfig = config

        self.check_interval = self.config.get("dispatcher_monitor_check_interval", 300)
        self.max_failures = self.config.get("dispatcher_monitor_max_failures", 2)

        # Registry of monitored thread pools
        self._pools: dict[str, dict] = {}
        self._pool_lock = threading.Lock()

        # thread pool monitor
        self._monitor_thread: threading.Thread | None = None
        self._running = False
        self._restart_in_progress = False

        # modules with thread pool
        self.dispatcher: SchedulerDispatcher | None = None
        self.dispatcher_pool_name = "dispatcher"

    def initialize(self, dispatcher: SchedulerDispatcher):
        self.dispatcher = dispatcher
        self.register_pool(
            name=self.dispatcher_pool_name,
            executor=self.dispatcher.dispatcher_executor,
            max_workers=self.dispatcher.max_workers,
            restart_on_failure=True,
        )

    def register_pool(
        self,
        name: str,
        executor: ContextThreadPoolExecutor,
        max_workers: int,
        restart_on_failure: bool = True,
    ) -> bool:
        """
        Register a thread pool for monitoring.

        Args:
            name: Unique identifier for the pool
            executor: ThreadPoolExecutor instance to monitor
            max_workers: Expected maximum worker count
            restart_on_failure: Whether to restart if pool fails

        Returns:
            bool: True if registration succeeded, False if pool already registered
        """
        with self._pool_lock:
            if name in self._pools:
                logger.warning(f"Thread pool '{name}' is already registered")
                return False

            self._pools[name] = {
                "executor": executor,
                "max_workers": max_workers,
                "restart": restart_on_failure,
                "failure_count": 0,
                "last_active": datetime.utcnow(),
                "healthy": True,
            }
            logger.info(f"Registered thread pool '{name}' for monitoring")
            return True

    def unregister_pool(self, name: str) -> bool:
        """
        Remove a thread pool from monitoring.

        Args:
            name: Identifier of the pool to remove

        Returns:
            bool: True if removal succeeded, False if pool not found
        """
        with self._pool_lock:
            if name not in self._pools:
                logger.warning(f"Thread pool '{name}' not found in registry")
                return False

            del self._pools[name]
            logger.info(f"Unregistered thread pool '{name}'")
            return True

    def _monitor_loop(self) -> None:
        """Main monitoring loop that periodically checks all registered pools."""
        logger.info(f"Starting monitor loop with {self.check_interval} second interval")

        while self._running:
            time.sleep(self.check_interval)
            try:
                self._check_pools_health()
            except Exception as e:
                logger.error(f"Error during health check: {e!s}", exc_info=True)

        logger.debug("Monitor loop exiting")

    def start(self) -> bool:
        """
        Start the monitoring thread.

        Returns:
            bool: True if monitor started successfully, False if already running
        """
        if self._running:
            logger.warning("Dispatcher Monitor is already running")
            return False

        self._running = True
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop, name="threadpool_monitor", daemon=True
        )
        self._monitor_thread.start()
        logger.info("Dispatcher Monitor  monitor started")
        return True

    def stop(self) -> None:
        """
        Stop the monitoring thread and clean up all managed thread pools.
        Ensures proper shutdown of all monitored executors.
        """
        if not self._running:
            return

        # Stop the monitoring loop
        self._running = False
        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=5)

        # Shutdown all registered pools
        with self._pool_lock:
            for name, pool_info in self._pools.items():
                executor = pool_info["executor"]
                if not executor._shutdown:  # pylint: disable=protected-access
                    try:
                        logger.info(f"Shutting down thread pool '{name}'")
                        executor.shutdown(wait=True, cancel_futures=True)
                        logger.info(f"Successfully shut down thread pool '{name}'")
                    except Exception as e:
                        logger.error(f"Error shutting down pool '{name}': {e!s}", exc_info=True)

        # Clear the pool registry
        self._pools.clear()
        logger.info("Thread pool monitor and all pools stopped")

    def _check_pools_health(self) -> None:
        """Check health of all registered thread pools."""
        for name, pool_info in list(self._pools.items()):
            is_healthy, reason = self._check_pool_health(
                pool_info=pool_info,
                stuck_max_interval=4,
            )
            logger.info(f"Pool '{name}'. is_healthy: {is_healthy}. pool_info: {pool_info}")
            with self._pool_lock:
                if is_healthy:
                    pool_info["failure_count"] = 0
                    pool_info["healthy"] = True
                    return
                else:
                    pool_info["failure_count"] += 1
                    pool_info["healthy"] = False
                    logger.info(
                        f"Pool '{name}' unhealthy ({pool_info['failure_count']}/{self.max_failures}): {reason}."
                        f" Note: This status does not necessarily indicate a problem with the pool itself - "
                        f"it may also be considered unhealthy if no tasks have been scheduled for an extended period"
                    )
            if (
                pool_info["failure_count"] >= self.max_failures
                and pool_info["restart"]
                and not self._restart_in_progress
            ):
                self._restart_pool(name, pool_info)

    def _check_pool_health(self, pool_info: dict, stuck_max_interval=4) -> tuple[bool, str]:
        """
        Check health of a single thread pool.

        Args:
            pool_info: Dictionary containing pool configuration

        Returns:
            Tuple: (is_healthy, reason) where reason explains failure if not healthy
        """
        executor = pool_info["executor"]

        # Check if executor is shutdown
        if executor._shutdown:  # pylint: disable=protected-access
            return False, "Executor is shutdown"

        # Check thread activity
        active_threads = sum(
            1
            for t in threading.enumerate()
            if t.name.startswith(executor._thread_name_prefix)  # pylint: disable=protected-access
        )

        # Check if no threads are active but should be
        if active_threads == 0 and pool_info["max_workers"] > 0:
            return False, "No active worker threads"

        # Check if threads are stuck (no activity for 2 intervals)
        time_delta = (datetime.utcnow() - pool_info["last_active"]).total_seconds()
        if time_delta >= self.check_interval * stuck_max_interval:
            return False, "No recent activity"

        # If we got here, pool appears healthy
        pool_info["last_active"] = datetime.utcnow()
        return True, ""

    def _restart_pool(self, name: str, pool_info: dict) -> None:
        """
        Attempt to restart a failed thread pool.

        Args:
            name: Name of the pool to restart
            pool_info: Dictionary containing pool configuration
        """
        if self._restart_in_progress:
            return

        self._restart_in_progress = True
        logger.info(f"Attempting to restart thread pool '{name}'")

        try:
            old_executor = pool_info["executor"]
            self.dispatcher.shutdown()

            # Create new executor with same parameters
            new_executor = ContextThreadPoolExecutor(
                max_workers=pool_info["max_workers"],
                thread_name_prefix=self.dispatcher.thread_name_prefix,  # pylint: disable=protected-access
            )
            self.unregister_pool(name=self.dispatcher_pool_name)
            self.dispatcher.dispatcher_executor = new_executor
            self.register_pool(
                name=self.dispatcher_pool_name,
                executor=self.dispatcher.dispatcher_executor,
                max_workers=self.dispatcher.max_workers,
                restart_on_failure=True,
            )

            # Replace in registry
            start_time = perf_counter()
            with self._pool_lock:
                pool_info["executor"] = new_executor
                pool_info["failure_count"] = 0
                pool_info["healthy"] = True
                pool_info["last_active"] = datetime.utcnow()

                elapsed_time = perf_counter() - start_time
                if elapsed_time > 1:
                    logger.warning(f"Long lock wait: {elapsed_time:.3f}s")

            # Shutdown old executor
            try:
                old_executor.shutdown(wait=False)
            except Exception as e:
                logger.error(f"Error shutting down old executor: {e!s}", exc_info=True)

            logger.info(f"Successfully restarted thread pool '{name}'")
        except Exception as e:
            logger.error(f"Failed to restart pool '{name}': {e!s}", exc_info=True)
        finally:
            self._restart_in_progress = False

    def get_status(self, name: str | None = None) -> dict:
        """
        Get status of monitored pools.

        Args:
            name: Optional specific pool name to check

        Returns:
            Dictionary of status information
        """
        with self._pool_lock:
            if name:
                return {name: self._pools.get(name, {}).copy()}
            return {k: v.copy() for k, v in self._pools.items()}

    def __enter__(self):
        """Context manager entry point."""
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit point."""
        self.stop()
