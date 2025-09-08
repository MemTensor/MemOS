import functools
import threading

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

from memos.api.context.context import (
    RequestContext,
    get_current_context,
    get_current_trace_id,
    set_request_context,
)


T = TypeVar("T")


class ContextThread(threading.Thread):
    """
    Thread class that automatically propagates the main thread's trace_id to child threads.
    """

    def __init__(self, target, args=(), kwargs=None, **thread_kwargs):
        super().__init__(**thread_kwargs)
        self.target = target
        self.args = args
        self.kwargs = kwargs or {}

        self.main_trace_id = get_current_trace_id()
        self.main_context = get_current_context()

    def run(self):
        # Create a new RequestContext with the main thread's trace_id
        if self.main_context:
            # Copy the context data
            child_context = RequestContext(trace_id=self.main_trace_id)
            child_context._data = self.main_context._data.copy()

            # Set the context in the child thread
            set_request_context(child_context)

        # Run the target function
        self.target(*self.args, **self.kwargs)


class ContextThreadPoolExecutor(ThreadPoolExecutor):
    """
    ThreadPoolExecutor that automatically propagates the main thread's trace_id to worker threads.
    """

    def submit(self, fn: Callable[..., T], *args: Any, **kwargs: Any) -> Any:
        """
        Submit a callable to be executed with the given arguments.
        Automatically propagates the current thread's context to the worker thread.
        """
        main_trace_id = get_current_trace_id()
        main_context = get_current_context()

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if main_context:
                # Create and set new context in worker thread
                child_context = RequestContext(trace_id=main_trace_id)
                child_context._data = main_context._data.copy()
                set_request_context(child_context)

            return fn(*args, **kwargs)

        return super().submit(wrapper, *args, **kwargs)

    def map(
        self,
        fn: Callable[..., T],
        *iterables: Any,
        timeout: float | None = None,
        chunksize: int = 1,
    ) -> Any:
        """
        Returns an iterator equivalent to map(fn, iter).
        Automatically propagates the current thread's context to worker threads.
        """
        main_trace_id = get_current_trace_id()
        main_context = get_current_context()

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if main_context:
                # Create and set new context in worker thread
                child_context = RequestContext(trace_id=main_trace_id)
                child_context._data = main_context._data.copy()
                set_request_context(child_context)

            return fn(*args, **kwargs)

        return super().map(wrapper, *iterables, timeout=timeout, chunksize=chunksize)
