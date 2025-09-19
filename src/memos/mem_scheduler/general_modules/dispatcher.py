import concurrent

from collections import defaultdict
from collections.abc import Callable

from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


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
    """

    def __init__(self, max_workers=30, enable_parallel_dispatch=False):
        super().__init__()
        # Main dispatcher thread pool
        self.max_workers = max_workers

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

    def _default_message_handler(self, messages: list[ScheduleMessageItem]) -> None:
        logger.debug(f"Using _default_message_handler to deal with messages: {messages}")

    def group_messages_by_user_and_cube(
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

        # Group messages by their labels, and organize messages by label
        label_groups = defaultdict(list)
        for message in msg_list:
            label_groups[message.label].append(message)

        # Process each label group
        for label, msgs in label_groups.items():
            handler = self.handlers.get(label, self._default_message_handler)

            # dispatch to different handler
            logger.debug(f"Dispatch {len(msgs)} message(s) to {label} handler.")
            if self.enable_parallel_dispatch and self.dispatcher_executor is not None:
                # Capture variables in lambda to avoid loop variable issues
                future = self.dispatcher_executor.submit(handler, msgs)
                self._futures.add(future)
                future.add_done_callback(self._handle_future_result)
                logger.info(f"Dispatched {len(msgs)} message(s) as future task")
            else:
                handler(msgs)

    def join(self, timeout: float | None = None) -> bool:
        """Wait for all dispatched tasks to complete.

        Args:
            timeout: Maximum time to wait in seconds. None means wait forever.

        Returns:
            bool: True if all tasks completed, False if timeout occurred.
        """
        if not self.enable_parallel_dispatch or self.dispatcher_executor is None:
            return True  # 串行模式无需等待

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
