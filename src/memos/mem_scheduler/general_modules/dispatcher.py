import concurrent
import threading

from collections import defaultdict
from collections.abc import Callable
from typing import Any

from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.general_modules.task_threads import ThreadManager
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import RunningTaskItem


logger = get_logger(__name__)


class SchedulerDispatcher(BaseSchedulerModule):
    """
    Thread pool-based message dispatcher that routes messages to dedicated handlers
    based on their labels.

    Features:
    - Dedicated thread pool per message label
    - Batch message processing
    - Graceful shutdown
    - Bulk handler registration
    - Thread race competition for parallel task execution
    """

    def __init__(self, max_workers=30, enable_parallel_dispatch=True, config=None):
        super().__init__()
        self.config = config

        # Main dispatcher thread pool
        self.max_workers = max_workers

        # Get multi-task timeout from config
        self.multi_task_running_timeout = (
            self.config.get("multi_task_running_timeout") if self.config else None
        )

        # Only initialize thread pool if in parallel mode
        self.enable_parallel_dispatch = enable_parallel_dispatch
        self.thread_name_prefix = "dispatcher"
        if self.enable_parallel_dispatch:
            self.dispatcher_executor = ContextThreadPoolExecutor(
                max_workers=self.max_workers, thread_name_prefix=self.thread_name_prefix
            )
        else:
            self.dispatcher_executor = None
        logger.info(f"enable_parallel_dispatch is set to {self.enable_parallel_dispatch}")

        # Registered message handlers
        self.handlers: dict[str, Callable] = {}

        # Dispatcher running state
        self._running = False

        # Set to track active futures for monitoring purposes
        self._futures = set()

        # Thread race module for competitive task execution
        self.thread_manager = ThreadManager(thread_pool_executor=self.dispatcher_executor)

        # Task tracking for monitoring
        self._running_tasks: dict[str, RunningTaskItem] = {}
        self._task_lock = threading.Lock()
        self._completed_tasks = []
        self.completed_tasks_max_show_size = 10

    def _create_task_wrapper(self, handler: Callable, task_item: RunningTaskItem):
        """
        Create a wrapper around the handler to track task execution and capture results.

        Args:
            handler: The original handler function
            task_item: The RunningTaskItem to track

        Returns:
            Wrapped handler function that captures results and logs completion
        """

        def wrapped_handler(messages: list[ScheduleMessageItem]):
            try:
                # Execute the original handler
                result = handler(messages)

                # Mark task as completed and remove from tracking
                with self._task_lock:
                    if task_item.item_id in self._running_tasks:
                        task_item.mark_completed(result)
                        del self._running_tasks[task_item.item_id]
                        self._completed_tasks.append(task_item)
                        if len(self._completed_tasks) > self.completed_tasks_max_show_size:
                            self._completed_tasks[-self.completed_tasks_max_show_size :]
                logger.info(f"Task completed: {task_item.get_execution_info()}")
                return result

            except Exception as e:
                # Mark task as failed and remove from tracking
                with self._task_lock:
                    if task_item.item_id in self._running_tasks:
                        task_item.mark_failed(str(e))
                        del self._running_tasks[task_item.item_id]
                        if len(self._completed_tasks) > self.completed_tasks_max_show_size:
                            self._completed_tasks[-self.completed_tasks_max_show_size :]
                logger.error(f"Task failed: {task_item.get_execution_info()}, Error: {e}")
                raise

        return wrapped_handler

    def get_running_tasks(
        self, filter_func: Callable[[RunningTaskItem], bool] | None = None
    ) -> dict[str, RunningTaskItem]:
        """
        Get a copy of currently running tasks, optionally filtered by a custom function.

        Args:
            filter_func: Optional function that takes a RunningTaskItem and returns True if it should be included.
                        Common filters can be created using helper methods like filter_by_user_id, filter_by_task_name, etc.

        Returns:
            Dictionary of running tasks keyed by task ID

        Examples:
            # Get all running tasks
            all_tasks = dispatcher.get_running_tasks()

            # Get tasks for specific user
            user_tasks = dispatcher.get_running_tasks(lambda task: task.user_id == "user123")

            # Get tasks for specific task name
            handler_tasks = dispatcher.get_running_tasks(lambda task: task.task_name == "test_handler")

            # Get tasks with multiple conditions
            filtered_tasks = dispatcher.get_running_tasks(
                lambda task: task.user_id == "user123" and task.status == "running"
            )
        """
        with self._task_lock:
            if filter_func is None:
                return self._running_tasks.copy()

            return {
                task_id: task_item
                for task_id, task_item in self._running_tasks.items()
                if filter_func(task_item)
            }

    def get_running_task_count(self) -> int:
        """
        Get the count of currently running tasks.

        Returns:
            Number of running tasks
        """
        with self._task_lock:
            return len(self._running_tasks)

    def register_handler(self, label: str, handler: Callable[[list[ScheduleMessageItem]], None]):
        """
        Register a handler function for a specific message label.

        Args:
            label: Message label to handle
            handler: Callable that processes messages of this label
        """
        self.handlers[label] = handler

    def register_handlers(
        self, handlers: dict[str, Callable[[list[ScheduleMessageItem]], None]]
    ) -> None:
        """
        Bulk register multiple handlers from a dictionary.

        Args:
            handlers: Dictionary mapping labels to handler functions
                      Format: {label: handler_callable}
        """
        for label, handler in handlers.items():
            if not isinstance(label, str):
                logger.error(f"Invalid label type: {type(label)}. Expected str.")
                continue
            if not callable(handler):
                logger.error(f"Handler for label '{label}' is not callable.")
                continue
            self.register_handler(label=label, handler=handler)
        logger.info(f"Registered {len(handlers)} handlers in bulk")

    def unregister_handler(self, label: str) -> bool:
        """
        Unregister a handler for a specific label.

        Args:
            label: The label to unregister the handler for

        Returns:
            bool: True if handler was found and removed, False otherwise
        """
        if label in self.handlers:
            del self.handlers[label]
            logger.info(f"Unregistered handler for label: {label}")
            return True
        else:
            logger.warning(f"No handler found for label: {label}")
            return False

    def unregister_handlers(self, labels: list[str]) -> dict[str, bool]:
        """
        Unregister multiple handlers by their labels.

        Args:
            labels: List of labels to unregister handlers for

        Returns:
            dict[str, bool]: Dictionary mapping each label to whether it was successfully unregistered
        """
        results = {}
        for label in labels:
            results[label] = self.unregister_handler(label)

        logger.info(f"Unregistered handlers for {len(labels)} labels")
        return results

    def _default_message_handler(self, messages: list[ScheduleMessageItem]) -> None:
        logger.debug(f"Using _default_message_handler to deal with messages: {messages}")

    def _group_messages_by_user_and_mem_cube(
        self, messages: list[ScheduleMessageItem]
    ) -> dict[str, dict[str, list[ScheduleMessageItem]]]:
        """
        Groups messages into a nested dictionary structure first by user_id, then by mem_cube_id.

        Args:
            messages: List of ScheduleMessageItem objects to be grouped

        Returns:
            A nested dictionary with the structure:
            {
                "user_id_1": {
                    "mem_cube_id_1": [msg1, msg2, ...],
                    "mem_cube_id_2": [msg3, msg4, ...],
                    ...
                },
                "user_id_2": {
                    ...
                },
                ...
            }
            Where each msg is the original ScheduleMessageItem object
        """
        grouped_dict = defaultdict(lambda: defaultdict(list))

        for msg in messages:
            grouped_dict[msg.user_id][msg.mem_cube_id].append(msg)

        # Convert defaultdict to regular dict for cleaner output
        return {user_id: dict(cube_groups) for user_id, cube_groups in grouped_dict.items()}

    def _handle_future_result(self, future):
        self._futures.remove(future)
        try:
            future.result()  # this will throw exception
        except Exception as e:
            logger.error(f"Handler execution failed: {e!s}", exc_info=True)

    def dispatch(self, msg_list: list[ScheduleMessageItem]):
        """
        Dispatch a list of messages to their respective handlers.

        Args:
            msg_list: List of ScheduleMessageItem objects to process
        """
        if not msg_list:
            logger.debug("Received empty message list, skipping dispatch")
            return

        # Group messages by user_id and mem_cube_id first
        user_cube_groups = self._group_messages_by_user_and_mem_cube(msg_list)

        # Process each user and mem_cube combination
        for user_id, cube_groups in user_cube_groups.items():
            for mem_cube_id, user_cube_msgs in cube_groups.items():
                # Group messages by their labels within each user/mem_cube combination
                label_groups = defaultdict(list)
                for message in user_cube_msgs:
                    label_groups[message.label].append(message)

                # Process each label group within this user/mem_cube combination
                for label, msgs in label_groups.items():
                    handler = self.handlers.get(label, self._default_message_handler)

                    # Create task tracking item for this dispatch
                    task_item = RunningTaskItem(
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        task_info=f"Processing {len(msgs)} message(s) with label '{label}' for user {user_id} and mem_cube {mem_cube_id}",
                        task_name=f"{label}_handler",
                        messages=msgs,
                    )

                    # Add to running tasks
                    with self._task_lock:
                        self._running_tasks[task_item.item_id] = task_item

                    # Create wrapped handler for task tracking
                    wrapped_handler = self._create_task_wrapper(handler, task_item)

                    # dispatch to different handler
                    logger.debug(
                        f"Dispatch {len(msgs)} message(s) to {label} handler for user {user_id} and mem_cube {mem_cube_id}."
                    )
                    logger.info(f"Task started: {task_item.get_execution_info()}")

                    if self.enable_parallel_dispatch and self.dispatcher_executor is not None:
                        # Capture variables in lambda to avoid loop variable issues
                        future = self.dispatcher_executor.submit(wrapped_handler, msgs)
                        self._futures.add(future)
                        future.add_done_callback(self._handle_future_result)
                        logger.info(f"Dispatched {len(msgs)} message(s) as future task")
                    else:
                        wrapped_handler(msgs)

    def join(self, timeout: float | None = None) -> bool:
        """Wait for all dispatched tasks to complete.

        Args:
            timeout: Maximum time to wait in seconds. None means wait forever.

        Returns:
            bool: True if all tasks completed, False if timeout occurred.
        """
        if not self.enable_parallel_dispatch or self.dispatcher_executor is None:
            return True  # Serial mode requires no waiting

        done, not_done = concurrent.futures.wait(
            self._futures, timeout=timeout, return_when=concurrent.futures.ALL_COMPLETED
        )

        # Check for exceptions in completed tasks
        for future in done:
            try:
                future.result()
            except Exception:
                logger.error("Handler failed during shutdown", exc_info=True)

        return len(not_done) == 0

    def run_competitive_tasks(
        self, tasks: dict[str, Callable[[threading.Event], Any]], timeout: float = 10.0
    ) -> tuple[str, Any] | None:
        """
        Run multiple tasks in a competitive race, returning the result of the first task to complete.

        Args:
            tasks: Dictionary mapping task names to task functions that accept a stop_flag parameter
            timeout: Maximum time to wait for any task to complete (in seconds)

        Returns:
            Tuple of (task_name, result) from the winning task, or None if no task completes
        """
        logger.info(f"Starting competitive execution of {len(tasks)} tasks")
        return self.thread_manager.run_race(tasks, timeout)

    def run_multiple_tasks(
        self,
        tasks: dict[str, tuple[Callable, tuple]],
        use_thread_pool: bool | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """
        Execute multiple tasks concurrently and return all results.

        Args:
            tasks: Dictionary mapping task names to (task_execution_function, task_execution_parameters) tuples
            use_thread_pool: Whether to use ThreadPoolExecutor. If None, uses dispatcher's parallel mode setting
            timeout: Maximum time to wait for all tasks to complete (in seconds). If None, uses config default.

        Returns:
            Dictionary mapping task names to their results

        Raises:
            TimeoutError: If tasks don't complete within the specified timeout
        """
        # Use dispatcher's parallel mode setting if not explicitly specified
        if use_thread_pool is None:
            use_thread_pool = self.enable_parallel_dispatch

        # Use config timeout if not explicitly provided
        if timeout is None:
            timeout = self.multi_task_running_timeout

        logger.info(
            f"Executing {len(tasks)} tasks concurrently (thread_pool: {use_thread_pool}, timeout: {timeout})"
        )

        try:
            results = self.thread_manager.run_multiple_tasks(
                tasks=tasks, use_thread_pool=use_thread_pool, timeout=timeout
            )
            logger.info(
                f"Successfully completed {len([r for r in results.values() if r is not None])}/{len(tasks)} tasks"
            )
            return results
        except Exception as e:
            logger.error(f"Multiple tasks execution failed: {e}", exc_info=True)
            raise

    def shutdown(self) -> None:
        """Gracefully shutdown the dispatcher."""
        self._running = False

        if self.dispatcher_executor is not None:
            # Cancel pending tasks
            cancelled = 0
            for future in self._futures:
                if future.cancel():
                    cancelled += 1
            logger.info(f"Cancelled {cancelled}/{len(self._futures)} pending tasks")

        # Shutdown executor
        try:
            self.dispatcher_executor.shutdown(wait=True)
        except Exception as e:
            logger.error(f"Executor shutdown error: {e}", exc_info=True)
        finally:
            self._futures.clear()

    def __enter__(self):
        self._running = True
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.shutdown()
