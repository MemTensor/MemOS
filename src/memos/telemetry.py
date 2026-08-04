"""
OpenTelemetry instrumentation for MemOS (memory-semconv v0.1.0).

Memory tier mapping:
  text_mem  → memory.tier = "textual"   (episodic / semantic long-term)
  act_mem   → memory.tier = "activation" (KV-cache / short-term activation)
  para_mem  → memory.tier = "parametric" (model-weights layer)
  pref_mem  → memory.tier = "preference" (user preference store)

Signals emitted:
  Traces   — spans on add / search / update / delete with rich attributes
  Metrics  — counters, histograms, and up-down counters for utilization
  Logs     — structured log records correlated with active span context
"""

from __future__ import annotations

import functools
import logging
import os
import time

from contextlib import contextmanager
from typing import Any, Callable

from opentelemetry import metrics, propagate, trace
from opentelemetry._logs import get_logger_provider, set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.propagators.composite import CompositeHTTPPropagator
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.semconv.resource import ResourceAttributes
from opentelemetry.trace import Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator


# ---------------------------------------------------------------------------
# Semconv attribute constants (memory-semconv v0.1.0)
# ---------------------------------------------------------------------------
MEMORY_TIER = "memory.tier"
MEMORY_OPERATION = "memory.operation"
MEMORY_ITEM_COUNT = "memory.item.count"
MEMORY_RESULT_COUNT = "memory.result.count"
MEMORY_QUERY_TEXT = "memory.query.text"
MEMORY_USER_ID = "memory.user.id"
MEMORY_CUBE_ID = "memory.cube.id"
MEMORY_SESSION_ID = "memory.session.id"
MEMORY_BACKEND = "memory.backend"
MEMORY_TOP_K = "memory.top_k"
MEMORY_HIT_COUNT = "memory.hit.count"
MEMORY_LATENCY_MS = "memory.latency.ms"
MEMORY_INDEX_SIZE = "memory.index.size"
MEMORY_UTILIZATION = "memory.utilization"

# Tier name constants
TIER_TEXTUAL = "textual"
TIER_ACTIVATION = "activation"
TIER_PARAMETRIC = "parametric"
TIER_PREFERENCE = "preference"

# Instrument name
INSTRUMENT_NAME = "memos"

_initialized = False
_tracer: trace.Tracer | None = None
_meter: metrics.Meter | None = None
_otel_logger: logging.Logger | None = None

# Metric instruments (created after meter is available)
_op_counter: metrics.Counter | None = None
_latency_histogram: metrics.Histogram | None = None
_item_count_gauge: metrics.ObservableGauge | None = None
_result_count_histogram: metrics.Histogram | None = None


def configure(
    service_name: str = "memos",
    service_version: str = "0.0.0",
    otlp_endpoint: str = "http://localhost:4317",
    export_interval_ms: int = 5000,
) -> None:
    """
    Configure OTel providers and install them globally.

    Call once at application startup (e.g., from MOSConfig or CLI entry-point).
    Safe to call multiple times; subsequent calls are no-ops.

    Args:
        service_name: OTel service.name resource attribute.
        service_version: OTel service.version resource attribute.
        otlp_endpoint: gRPC OTLP collector endpoint (e.g. http://otel-collector:4317).
        export_interval_ms: Metric export interval in milliseconds.
    """
    global _initialized, _tracer, _meter, _otel_logger
    global _op_counter, _latency_histogram, _result_count_histogram

    if _initialized:
        return

    resource = Resource.create(
        {
            ResourceAttributes.SERVICE_NAME: service_name,
            ResourceAttributes.SERVICE_VERSION: service_version,
        }
    )

    # Install W3C TraceContext propagator so traceparent/tracestate headers are
    # extracted from incoming requests and injected into outgoing calls.
    propagate.set_global_textmap(
        CompositeHTTPPropagator([TraceContextTextMapPropagator()])
    )

    # --- Traces ---
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=otlp_endpoint))
    )
    trace.set_tracer_provider(tracer_provider)
    _tracer = trace.get_tracer(INSTRUMENT_NAME)

    # --- Metrics ---
    metric_reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(endpoint=otlp_endpoint),
        export_interval_millis=export_interval_ms,
    )
    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)
    _meter = metrics.get_meter(INSTRUMENT_NAME)

    _op_counter = _meter.create_counter(
        name="memory.operations",
        unit="{operation}",
        description="Total number of memory operations",
    )
    _latency_histogram = _meter.create_histogram(
        name="memory.operation.duration",
        unit="ms",
        description="Duration of memory operations in milliseconds",
    )
    _result_count_histogram = _meter.create_histogram(
        name="memory.result.count",
        unit="{item}",
        description="Number of results returned per search operation",
    )

    # --- Logs ---
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter(endpoint=otlp_endpoint))
    )
    set_logger_provider(logger_provider)

    otel_handler = LoggingHandler(level=logging.DEBUG, logger_provider=logger_provider)
    root_logger = logging.getLogger("memos")
    root_logger.addHandler(otel_handler)
    _otel_logger = logging.getLogger(f"{INSTRUMENT_NAME}.ops")

    _initialized = True


def _resolve_service_version(explicit: str | None = None) -> str:
    """Best-effort service.version: explicit env value, else installed pkg, else 0.0.0."""
    if explicit:
        return explicit
    try:
        from importlib.metadata import PackageNotFoundError, version

        for dist in ("MemoryOS", "memoryos", "memos"):
            try:
                return version(dist)
            except PackageNotFoundError:
                continue
    except Exception:  # pragma: no cover - importlib.metadata always present on 3.11
        pass
    return "0.0.0"


def configure_from_env() -> bool:
    """
    Bootstrap OTel from environment variables at process startup.

    This is the server-side bootstrap that makes the ``memory.*`` spans/metrics/logs
    emitted by the instrumentation in ``memos.mem_os.core`` actually reach a
    collector.  Without it, ``get_tracer()``/``get_meter()`` return the global
    no-op providers and nothing is exported.

    Telemetry is enabled only when an OTLP endpoint is configured, so local/dev
    runs without a collector stay a pure no-op.  Recognised variables:

      OTEL_EXPORTER_OTLP_ENDPOINT   gRPC OTLP endpoint (enables telemetry when set),
                                    e.g. http://otel-collector.observability:4317
      OTEL_SERVICE_NAME             service.name resource attribute (default: memos)
      OTEL_SERVICE_VERSION          service.version (default: installed package version)
      OTEL_METRIC_EXPORT_INTERVAL   metric export interval in ms (default: 5000)
      MEMOS_OTEL_ENABLED            set to a falsy value to force-disable even when
                                    an endpoint is present

    Returns True when telemetry was configured, False when it was skipped.
    """
    enabled_flag = os.getenv("MEMOS_OTEL_ENABLED")
    if enabled_flag is not None and enabled_flag.strip().lower() in {
        "0",
        "false",
        "no",
        "off",
        "",
    }:
        return False

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        # No collector configured — leave the SDK as a no-op so local runs are silent.
        return False

    try:
        interval_ms = int(os.getenv("OTEL_METRIC_EXPORT_INTERVAL", "5000"))
    except ValueError:
        interval_ms = 5000

    configure(
        service_name=os.getenv("OTEL_SERVICE_NAME", "memos"),
        service_version=_resolve_service_version(os.getenv("OTEL_SERVICE_VERSION")),
        otlp_endpoint=endpoint,
        export_interval_ms=interval_ms,
    )
    return _initialized


def get_tracer() -> trace.Tracer:
    """Return the global tracer (no-op if OTel is not configured)."""
    if _tracer is not None:
        return _tracer
    return trace.get_tracer(INSTRUMENT_NAME)


def get_meter() -> metrics.Meter:
    """Return the global meter (no-op if OTel is not configured)."""
    if _meter is not None:
        return _meter
    return metrics.get_meter(INSTRUMENT_NAME)


# ---------------------------------------------------------------------------
# Low-level span helpers
# ---------------------------------------------------------------------------

@contextmanager
def memory_span(
    operation: str,
    tier: str,
    attributes: dict[str, Any] | None = None,
):
    """
    Context manager that wraps a memory operation in an OTel span.

    Args:
        operation: One of add / search / update / delete.
        tier: Memory tier (textual / activation / parametric / preference).
        attributes: Extra span attributes to merge in.

    Yields the span so callers can add result attributes after the operation.
    """
    tracer = get_tracer()
    span_attrs: dict[str, Any] = {
        MEMORY_OPERATION: operation,
        MEMORY_TIER: tier,
    }
    if attributes:
        span_attrs.update(attributes)

    with tracer.start_as_current_span(
        f"memory.{operation}",
        kind=trace.SpanKind.INTERNAL,
        attributes=span_attrs,
    ) as span:
        t0 = time.perf_counter()
        try:
            yield span
            span.set_status(Status(StatusCode.OK))
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise
        finally:
            elapsed_ms = (time.perf_counter() - t0) * 1000
            span.set_attribute(MEMORY_LATENCY_MS, round(elapsed_ms, 2))
            _record_op_metrics(operation, tier, elapsed_ms, span_attrs)


def _record_op_metrics(
    operation: str,
    tier: str,
    latency_ms: float,
    attrs: dict[str, Any],
) -> None:
    """Record counter + latency histogram for a completed operation."""
    if _op_counter is None or _latency_histogram is None:
        return
    label = {MEMORY_OPERATION: operation, MEMORY_TIER: tier}
    _op_counter.add(1, label)
    _latency_histogram.record(latency_ms, label)


def record_result_count(count: int, tier: str, operation: str = "search") -> None:
    """Record the number of items returned by a search."""
    if _result_count_histogram is not None:
        _result_count_histogram.record(
            count, {MEMORY_TIER: tier, MEMORY_OPERATION: operation}
        )


def instrument_op(operation: str, tier: str) -> Callable:
    """
    Decorator that wraps a MemOS method in an OTel span + metrics.

    Injects ``user_id`` and ``mem_cube_id`` attributes from matching keyword
    arguments when present.  Does NOT capture query text (use ``memory_span``
    directly in ``search`` for that).
    """
    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            attrs: dict[str, Any] = {
                MEMORY_USER_ID: str(kwargs.get("user_id") or ""),
                MEMORY_CUBE_ID: str(kwargs.get("mem_cube_id") or ""),
                MEMORY_SESSION_ID: str(kwargs.get("session_id") or ""),
            }
            with memory_span(operation, tier, attrs) as span:
                result = fn(*args, **kwargs)
                # Annotate item count for add operations
                if operation == "add":
                    messages = kwargs.get("messages")
                    count = len(messages) if messages is not None else 1
                    span.set_attribute(MEMORY_ITEM_COUNT, count)
                    emit_op_log(
                        logging.INFO,
                        operation,
                        tier,
                        f"memory.{operation} completed",
                        {MEMORY_CUBE_ID: str(kwargs.get("mem_cube_id") or ""), MEMORY_ITEM_COUNT: count},
                    )
                else:
                    emit_op_log(logging.INFO, operation, tier, f"memory.{operation} completed")
                return result
        return wrapper
    return decorator


def emit_op_log(
    level: int,
    operation: str,
    tier: str,
    message: str,
    extra: dict[str, Any] | None = None,
) -> None:
    """Emit a structured log record correlated with the current span context."""
    logger = _otel_logger or logging.getLogger(f"{INSTRUMENT_NAME}.ops")
    record_extra = {
        MEMORY_OPERATION: operation,
        MEMORY_TIER: tier,
    }
    if extra:
        record_extra.update(extra)
    logger.log(level, message, extra=record_extra)
