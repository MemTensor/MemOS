"""
Global thread pool manager
Used to uniformly manage thread pools in the memory system, avoiding creating too many thread pools that could lead to resource exhaustion
"""

import threading

from concurrent.futures import ThreadPoolExecutor

from memos.log import get_logger


logger = get_logger(__name__)


class GlobalThreadPoolManager:
    """Global thread pool manager, using singleton pattern to ensure only one thread pool instance"""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if not self._initialized:
            # Create a globally shared thread pool with limited total thread count
            # Adjust max_workers based on system core count and expected concurrency
            max_workers = min(32, (threading.active_count() or 1) + 16)
            self.executor = ThreadPoolExecutor(
                max_workers=max_workers, thread_name_prefix="MemoryManager"
            )
            self._initialized = True
            logger.info(f"Global thread pool initialized with {max_workers} workers")

    def submit(self, fn, *args, **kwargs):
        """Submit task to thread pool"""
        return self.executor.submit(fn, *args, **kwargs)

    def shutdown(self, wait=True):
        """Shutdown thread pool"""
        if hasattr(self, "executor"):
            logger.info("Shutting down global thread pool...")
            self.executor.shutdown(wait=wait)

    def get_status(self):
        """Get thread pool status information"""
        if hasattr(self, "executor"):
            return {
                "max_workers": self.executor._max_workers,
                "active_threads": threading.active_count(),
            }
        return {"status": "not_initialized"}


# Global thread pool instance
_global_pool = GlobalThreadPoolManager()


def get_global_pool() -> GlobalThreadPoolManager:
    """Get global thread pool instance"""
    return _global_pool


def shutdown_global_pool():
    """Shutdown global thread pool"""
    _global_pool.shutdown()
