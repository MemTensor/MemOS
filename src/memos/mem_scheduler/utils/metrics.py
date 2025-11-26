# src/memos/mem_scheduler/utils/metrics.py
import time

from contextlib import ContextDecorator

from prometheus_client import Counter, Gauge, Histogram, Summary


# --- Metric Definitions ---

TASKS_ENQUEUED_TOTAL = Counter(
    "memos_scheduler_tasks_enqueued_total",
    "Total number of tasks enqueued",
    ["user_id", "task_type"],
)

TASKS_DEQUEUED_TOTAL = Counter(
    "memos_scheduler_tasks_dequeued_total",
    "Total number of tasks dequeued",
    ["user_id", "task_type"],
)

TASK_DURATION_SECONDS = Summary(
    "memos_scheduler_task_duration_seconds",
    "Task processing duration in seconds",
    ["user_id", "task_type"],
)

TASK_WAIT_DURATION_SECONDS = Summary(
    "memos_scheduler_task_wait_duration_seconds",
    "Task waiting duration in seconds",
    ["user_id", "task_type"],
)

TASKS_FAILED_TOTAL = Counter(
    "memos_scheduler_tasks_failed_total",
    "Total number of failed tasks",
    ["user_id", "task_type", "error_type"],
)

TASKS_COMPLETED_TOTAL = Counter(
    "memos_scheduler_tasks_completed_total",
    "Total number of successfully completed tasks",
    ["user_id", "task_type"],
)

QUEUE_LENGTH = Gauge(
    "memos_scheduler_queue_length", "Current length of the task queue", ["user_id"]
)

INTERNAL_SPAN_DURATION = Histogram(
    "memos_scheduler_internal_span_duration_seconds",
    "Duration of internal operations",
    ["span_name", "user_id", "task_id"],
)


# --- Instrumentation Functions ---


def task_enqueued(user_id: str, task_type: str, count: int = 1):
    TASKS_ENQUEUED_TOTAL.labels(user_id=user_id, task_type=task_type).inc(count)


def task_dequeued(user_id: str, task_type: str, count: int = 1):
    TASKS_DEQUEUED_TOTAL.labels(user_id=user_id, task_type=task_type).inc(count)


def observe_task_duration(duration: float, user_id: str, task_type: str):
    TASK_DURATION_SECONDS.labels(user_id=user_id, task_type=task_type).observe(duration)


def observe_task_wait_duration(duration: float, user_id: str, task_type: str):
    TASK_WAIT_DURATION_SECONDS.labels(user_id=user_id, task_type=task_type).observe(duration)


def task_failed(user_id: str, task_type: str, error_type: str):
    TASKS_FAILED_TOTAL.labels(user_id=user_id, task_type=task_type, error_type=error_type).inc()


def task_completed(user_id: str, task_type: str, count: int = 1):
    TASKS_COMPLETED_TOTAL.labels(user_id=user_id, task_type=task_type).inc(count)


def update_queue_length(length: int, user_id: str):
    QUEUE_LENGTH.labels(user_id=user_id).set(length)


def observe_internal_span(duration: float, span_name: str, user_id: str, task_id: str):
    INTERNAL_SPAN_DURATION.labels(span_name=span_name, user_id=user_id, task_id=task_id).observe(
        duration
    )


# --- TimingSpan Context Manager ---


class TimingSpan(ContextDecorator):
    """
    A context manager/decorator to measure the duration of a code block and record it
    as a Prometheus histogram observation.

    Usage as a decorator:
    @TimingSpan("expensive_operation", user_id="user123")
    def my_function():
        time.sleep(2)

    Usage as a context manager:
    with TimingSpan("another_op", user_id="user456", task_id="t1"):
        ...
    """

    def __init__(self, span_name: str, user_id: str = "unknown", task_id: str = "unknown"):
        self.span_name = span_name
        self.user_id = user_id
        self.task_id = task_id
        self.start_time = 0

    def __enter__(self):
        self.start_time = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        duration = time.perf_counter() - self.start_time
        observe_internal_span(duration, self.span_name, self.user_id, self.task_id)
