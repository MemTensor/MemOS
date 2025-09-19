import time

from memos.context.context import (
    ContextThread,
    ContextThreadPoolExecutor,
    RequestContext,
    get_current_context,
    set_request_context,
)
from memos.log import get_logger


logger = get_logger(__name__)


def task_with_context(task_name: str, delay: int) -> tuple[str, str | None]:
    """Test task function that returns task name and current context's trace_id"""
    context = get_current_context()
    trace_id = context.trace_id if context else None
    logger.info(f"Task {task_name} running with trace_id: {trace_id}")
    time.sleep(delay)
    return task_name, trace_id


def test_context_thread_propagation():
    """Test if ContextThread correctly propagates context from main thread to child thread"""
    # Set up main thread context
    main_context = RequestContext(trace_id="main-thread-trace")
    main_context.test_data = "test value"  # Add extra context data
    set_request_context(main_context)

    # Store child thread results
    results = {}

    def thread_task():
        # Get context in child thread
        child_context = get_current_context()
        results["trace_id"] = child_context.trace_id if child_context else None
        results["test_data"] = child_context.test_data if child_context else None

    # Create and run child thread
    thread = ContextThread(target=thread_task)
    thread.start()
    thread.join()

    # Verify context propagation
    assert results["trace_id"] == "main-thread-trace"
    assert results["test_data"] == "test value"


def test_context_thread_pool_propagation():
    """Test if ContextThreadPoolExecutor correctly propagates context to worker threads"""
    # Set up main thread context
    main_context = RequestContext(trace_id="pool-test-trace")
    main_context.test_data = "pool test value"
    set_request_context(main_context)

    def pool_task():
        context = get_current_context()
        return {
            "trace_id": context.trace_id if context else None,
            "test_data": context.test_data if context else None,
        }

    # Use thread pool to execute task
    with ContextThreadPoolExecutor(max_workers=2) as executor:
        future = executor.submit(pool_task)
        result = future.result()

        # Verify context propagation
        assert result["trace_id"] == "pool-test-trace"
        assert result["test_data"] == "pool test value"


def test_context_thread_pool_map_propagation():
    """Test if ContextThreadPoolExecutor's map method correctly propagates context"""
    # Set up main thread context
    main_context = RequestContext(trace_id="map-test-trace")
    main_context.test_data = "map test value"
    set_request_context(main_context)

    def map_task(task_id: int):
        context = get_current_context()
        return {
            "task_id": task_id,
            "trace_id": context.trace_id if context else None,
            "test_data": context.test_data if context else None,
        }

    # Use thread pool's map method to execute multiple tasks
    with ContextThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(map_task, range(4)))

    # Verify context propagation for each task
    for i, result in enumerate(results):
        assert result["task_id"] == i
        assert result["trace_id"] == "map-test-trace"
        assert result["test_data"] == "map test value"


def test_context_thread_isolation():
    """Test context isolation between different threads"""
    # Set up main thread context
    main_context = RequestContext(trace_id="isolation-test-trace")
    main_context.test_data = "main thread data"
    set_request_context(main_context)

    results = []

    def thread_task(task_id: str, custom_data: str):
        # Get and maintain reference to context in child thread
        context = get_current_context()
        if context:
            # Modify context data
            context.test_data = custom_data
            # Re-set context to make modifications take effect
            set_request_context(context)

        # Get modified context data
        current_context = get_current_context()
        results.append(
            {
                "task_id": task_id,
                "test_data": current_context.test_data if current_context else None,
            }
        )

    # Create two threads with different data
    thread1 = ContextThread(target=thread_task, args=("thread1", "thread1 data"))
    thread2 = ContextThread(target=thread_task, args=("thread2", "thread2 data"))

    thread1.start()
    thread2.start()
    thread1.join()
    thread2.join()

    # Verify thread isolation
    thread1_result = next(r for r in results if r["task_id"] == "thread1")
    thread2_result = next(r for r in results if r["task_id"] == "thread2")

    assert thread1_result["test_data"] == "thread1 data"
    assert thread2_result["test_data"] == "thread2 data"

    # Verify main thread context wasn't modified by child threads
    main_context_after = get_current_context()
    assert main_context_after.test_data == "main thread data"


def test_context_thread_error_with_context():
    """Test context propagation when error occurs in thread"""
    # Set up main thread context
    main_context = RequestContext(trace_id="error-test-trace")
    main_context.test_data = "error test data"
    set_request_context(main_context)

    error_context = {}

    def error_task():
        try:
            context = get_current_context()
            error_context["trace_id"] = context.trace_id if context else None
            error_context["test_data"] = context.test_data if context else None
            raise ValueError("Test error")
        except ValueError:
            # We should still be able to access context even after error
            context = get_current_context()
            error_context["after_error_trace_id"] = context.trace_id if context else None
            error_context["after_error_test_data"] = context.test_data if context else None
            raise

    thread = ContextThread(target=error_task)
    thread.start()
    thread.join()  # Thread will terminate due to error, but we can still verify context

    # Verify context before and after error
    assert error_context["trace_id"] == "error-test-trace"
    assert error_context["test_data"] == "error test data"
    assert error_context["after_error_trace_id"] == "error-test-trace"
    assert error_context["after_error_test_data"] == "error test data"
