import threading

from collections.abc import Callable
from typing import Any, TypeVar

from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule


logger = get_logger(__name__)

T = TypeVar("T")


class ThreadRace(BaseSchedulerModule):
    """
    Thread race implementation that runs multiple tasks concurrently and returns
    the result of the first task to complete successfully.

    Features:
    - Cooperative thread termination using stop flags
    - Configurable timeout for tasks
    - Automatic cleanup of slower threads
    - Thread-safe result handling
    """

    def __init__(self):
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
            thread = threading.Thread(
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
