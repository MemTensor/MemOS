import threading
import time

from collections.abc import Callable
from concurrent.futures import as_completed
from typing import Any, TypeVar

from memos.context.context import ContextThread
from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule


logger = get_logger(__name__)

T = TypeVar("T")


class ThreadManager(BaseSchedulerModule):
    """
    Thread race implementation that runs multiple tasks concurrently and returns
    the result of the first task to complete successfully.

    Features:
    - Cooperative thread termination using stop flags
    - Configurable timeout for tasks
    - Automatic cleanup of slower threads
    - Thread-safe result handling
    """

    def __init__(self, thread_pool_executor=None):
        super().__init__()
        # Variable to store the result
        self.result: tuple[str, Any] | None = None
        # Event to mark if the race is finished
        self.race_finished = threading.Event()
        # Lock to protect the result variable
        self.lock = threading.Lock()
        # Store thread objects for termination
        self.threads: dict[str, threading.Thread] = {}
        # Stop flags for each thread
        self.stop_flags: dict[str, threading.Event] = {}
        # attributes
        self.thread_pool_executor = thread_pool_executor

    def worker(
        self, task_func: Callable[[threading.Event], T], task_name: str
    ) -> tuple[str, T] | None:
        """
        Worker thread function that executes a task and handles result reporting.

        Args:
            task_func: Function to execute with a stop_flag parameter
            task_name: Name identifier for this task/thread

        Returns:
            Tuple of (task_name, result) if this thread wins the race, None otherwise
        """
        # Create a stop flag for this task
        stop_flag = threading.Event()
        self.stop_flags[task_name] = stop_flag

        try:
            # Execute the task with stop flag
            result = task_func(stop_flag)

            # If the race is already finished or we were asked to stop, return immediately
            if self.race_finished.is_set() or stop_flag.is_set():
                return None

            # Try to set the result (if no other thread has set it yet)
            with self.lock:
                if not self.race_finished.is_set():
                    self.result = (task_name, result)
                    # Mark the race as finished
                    self.race_finished.set()
                    logger.info(f"Task '{task_name}' won the race")

                    # Signal other threads to stop
                    for name, flag in self.stop_flags.items():
                        if name != task_name:
                            logger.debug(f"Signaling task '{name}' to stop")
                            flag.set()

                    return self.result

        except Exception as e:
            logger.error(f"Task '{task_name}' encountered an error: {e}")

        return None

    def run_multiple_tasks(
        self,
        tasks: dict[str, tuple[Callable, tuple]],
        use_thread_pool: bool = False,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """
        Run multiple tasks concurrently and return all results.

        Args:
            tasks: Dictionary mapping task names to (task_execution_function, task_execution_parameters) tuples
            use_thread_pool: Whether to use ThreadPoolExecutor (True) or regular threads (False)
            timeout: Maximum time to wait for all tasks to complete (in seconds). None for infinite timeout.

        Returns:
            Dictionary mapping task names to their results

        Raises:
            TimeoutError: If tasks don't complete within the specified timeout
        """
        if not tasks:
            logger.warning("No tasks provided to run_multiple_tasks")
            return {}

        results = {}
        start_time = time.time()

        if use_thread_pool:
            # Convert tasks format for thread pool compatibility
            thread_pool_tasks = {}
            for task_name, (func, args) in tasks.items():
                thread_pool_tasks[task_name] = (func, args, {})
            return self.run_with_thread_pool(thread_pool_tasks, timeout)
        else:
            # Use regular threads
            threads = {}
            thread_results = {}
            exceptions = {}

            def worker(task_name: str, func: Callable, args: tuple):
                """Worker function for regular threads"""
                try:
                    result = func(*args)
                    thread_results[task_name] = result
                    logger.debug(f"Task '{task_name}' completed successfully")
                except Exception as e:
                    exceptions[task_name] = e
                    logger.error(f"Task '{task_name}' failed with error: {e}")

            # Start all threads
            for task_name, (func, args) in tasks.items():
                thread = ContextThread(
                    target=worker, args=(task_name, func, args), name=f"task-{task_name}"
                )
                threads[task_name] = thread
                thread.start()
                logger.debug(f"Started thread for task '{task_name}'")

            # Wait for all threads to complete with timeout
            for task_name, thread in threads.items():
                if timeout is None:
                    # Infinite timeout - wait indefinitely
                    thread.join()
                else:
                    # Finite timeout - calculate remaining time
                    remaining_time = timeout - (time.time() - start_time)
                    if remaining_time <= 0:
                        logger.error(f"Task '{task_name}' timed out after {timeout} seconds")
                        results[task_name] = None
                        continue

                    thread.join(timeout=remaining_time)
                    if thread.is_alive():
                        logger.error(f"Task '{task_name}' timed out after {timeout} seconds")
                        results[task_name] = None
                        continue

                # Get result or exception (for both infinite and finite timeout cases)
                if task_name in thread_results:
                    results[task_name] = thread_results[task_name]
                elif task_name in exceptions:
                    results[task_name] = None
                else:
                    results[task_name] = None

        elapsed_time = time.time() - start_time
        completed_tasks = sum(1 for result in results.values() if result is not None)
        logger.info(f"Completed {completed_tasks}/{len(tasks)} tasks in {elapsed_time:.2f} seconds")

        return results

    def run_with_thread_pool(
        self, tasks: dict[str, tuple[callable, tuple, dict]], timeout: float | None = None
    ) -> dict[str, Any]:
        """
        Execute multiple tasks using ThreadPoolExecutor.

        Args:
            tasks: Dictionary mapping task names to (function, args, kwargs) tuples
            timeout: Maximum time to wait for all tasks to complete (None for infinite timeout)

        Returns:
            Dictionary mapping task names to their results

        Raises:
            TimeoutError: If tasks don't complete within the specified timeout
        """
        if self.thread_pool_executor is None:
            logger.error("thread_pool_executor is None")
            raise ValueError("ThreadPoolExecutor is not initialized")

        results = {}
        start_time = time.time()

        # Check if executor is shutdown before using it
        if self.thread_pool_executor._shutdown:
            logger.error("ThreadPoolExecutor is already shutdown, cannot submit new tasks")
            raise RuntimeError("ThreadPoolExecutor is already shutdown")

        # Use ThreadPoolExecutor directly without context manager
        # The executor lifecycle is managed by the parent SchedulerDispatcher
        executor = self.thread_pool_executor

        # Submit all tasks
        future_to_name = {}
        for task_name, (func, args, kwargs) in tasks.items():
            try:
                future = executor.submit(func, *args, **kwargs)
                future_to_name[future] = task_name
                logger.debug(f"Submitted task '{task_name}' to thread pool")
            except RuntimeError as e:
                if "cannot schedule new futures after shutdown" in str(e):
                    logger.error(
                        f"Cannot submit task '{task_name}': ThreadPoolExecutor is shutdown"
                    )
                    results[task_name] = None
                else:
                    raise

        # Collect results as they complete
        try:
            # Handle infinite timeout case
            timeout_param = None if timeout is None else timeout
            for future in as_completed(future_to_name, timeout=timeout_param):
                task_name = future_to_name[future]
                try:
                    result = future.result()
                    results[task_name] = result
                    logger.debug(f"Task '{task_name}' completed successfully")
                except Exception as e:
                    logger.error(f"Task '{task_name}' failed with error: {e}")
                    results[task_name] = None

        except Exception:
            elapsed_time = time.time() - start_time
            timeout_msg = "infinite" if timeout is None else f"{timeout}s"
            logger.error(
                f"Tasks execution timed out after {elapsed_time:.2f} seconds (timeout: {timeout_msg})"
            )
            # Cancel remaining futures
            for future in future_to_name:
                if not future.done():
                    future.cancel()
                    task_name = future_to_name[future]
                    logger.warning(f"Cancelled task '{task_name}' due to timeout")
                    results[task_name] = None
            timeout_seconds = "infinite" if timeout is None else timeout
            logger.error(f"Tasks execution timed out after {timeout_seconds} seconds")

        return results

    def run_race(
        self, tasks: dict[str, Callable[[threading.Event], T]], timeout: float = 10.0
    ) -> tuple[str, T] | None:
        """
        Start a competition between multiple tasks and return the result of the fastest one.

        Args:
            tasks: Dictionary mapping task names to task functions
            timeout: Maximum time to wait for any task to complete (in seconds)

        Returns:
            Tuple of (task_name, result) from the winning task, or None if no task completes
        """
        if not tasks:
            logger.warning("No tasks provided for the race")
            return None

        # Reset state
        self.race_finished.clear()
        self.result = None
        self.threads.clear()
        self.stop_flags.clear()

        # Create and start threads for each task
        for task_name, task_func in tasks.items():
            thread = ContextThread(
                target=self.worker, args=(task_func, task_name), name=f"race-{task_name}"
            )
            self.threads[task_name] = thread
            thread.start()
            logger.debug(f"Started task '{task_name}'")

        # Wait for any thread to complete or timeout
        race_completed = self.race_finished.wait(timeout=timeout)

        if not race_completed:
            logger.warning(f"Race timed out after {timeout} seconds")
            # Signal all threads to stop
            for _name, flag in self.stop_flags.items():
                flag.set()

        # Wait for all threads to end (with timeout to avoid infinite waiting)
        for _name, thread in self.threads.items():
            thread.join(timeout=1.0)
            if thread.is_alive():
                logger.warning(f"Thread '{_name}' did not terminate within the join timeout")

        # Return the result
        if self.result:
            logger.info(f"Race completed. Winner: {self.result[0]}")
        else:
            logger.warning("Race completed with no winner")

        return self.result
