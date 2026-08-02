"""
Validate MemOS OTel instrumentation (memory-semconv v0.1.0).

Uses in-memory exporters — no external collector required.
"""
import importlib.util
import pathlib
import sys
import types
import pytest

from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry import trace, metrics

# Load telemetry directly to avoid memos heavy __init__ chain
_tel_path = pathlib.Path(__file__).parent.parent / "src" / "memos" / "telemetry.py"
_spec = importlib.util.spec_from_file_location("memos.telemetry", _tel_path)
tel = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tel)


@pytest.fixture(autouse=True)
def reset_telemetry():
    """Reset telemetry module globals between tests."""
    tel._initialized = False
    tel._tracer = None
    tel._meter = None
    tel._otel_logger = None
    tel._op_counter = None
    tel._latency_histogram = None
    tel._result_count_histogram = None
    yield
    tel._initialized = False


@pytest.fixture()
def in_memory_providers():
    """Wire up in-memory OTel providers and return exporters for assertions."""
    span_exporter = InMemorySpanExporter()
    tracer_provider = TracerProvider()
    tracer_provider.add_span_processor(SimpleSpanProcessor(span_exporter))
    trace.set_tracer_provider(tracer_provider)
    tel._tracer = tracer_provider.get_tracer(tel.INSTRUMENT_NAME)

    metric_reader = InMemoryMetricReader()
    meter_provider = MeterProvider(metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)
    tel._meter = meter_provider.get_meter(tel.INSTRUMENT_NAME)

    tel._op_counter = tel._meter.create_counter("memory.operations")
    tel._latency_histogram = tel._meter.create_histogram("memory.operation.duration")
    tel._result_count_histogram = tel._meter.create_histogram("memory.result.count")
    tel._initialized = True

    return span_exporter, metric_reader


def test_memory_span_creates_span_with_semconv_attrs(in_memory_providers):
    span_exporter, _ = in_memory_providers

    with tel.memory_span("search", tel.TIER_TEXTUAL, {"memory.query.text": "test query"}):
        pass

    spans = span_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]

    assert span.name == "memory.search"
    assert span.attributes[tel.MEMORY_OPERATION] == "search"
    assert span.attributes[tel.MEMORY_TIER] == tel.TIER_TEXTUAL
    assert span.attributes["memory.query.text"] == "test query"
    assert tel.MEMORY_LATENCY_MS in span.attributes
    assert span.attributes[tel.MEMORY_LATENCY_MS] >= 0


def test_memory_span_records_error_on_exception(in_memory_providers):
    from opentelemetry.trace import StatusCode

    span_exporter, _ = in_memory_providers

    with pytest.raises(ValueError):
        with tel.memory_span("add", tel.TIER_TEXTUAL):
            raise ValueError("boom")

    spans = span_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR


def test_record_result_count_emits_metric(in_memory_providers):
    _, metric_reader = in_memory_providers

    tel.record_result_count(5, tel.TIER_TEXTUAL)

    data = metric_reader.get_metrics_data()
    names = {
        metric.name
        for rm in data.resource_metrics
        for sm in rm.scope_metrics
        for metric in sm.metrics
    }
    assert "memory.result.count" in names


def test_instrument_op_decorator_emits_span(in_memory_providers):
    span_exporter, _ = in_memory_providers

    class FakeMemOS:
        @tel.instrument_op("add", tel.TIER_TEXTUAL)
        def add(self, messages=None, mem_cube_id=None, user_id=None, session_id=None):
            return "done"

    obj = FakeMemOS()
    result = obj.add(messages=[{"role": "user", "content": "hi"}], user_id="u1", mem_cube_id="cube1")
    assert result == "done"

    spans = span_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "memory.add"
    assert span.attributes[tel.MEMORY_OPERATION] == "add"
    assert span.attributes[tel.MEMORY_TIER] == tel.TIER_TEXTUAL
    assert span.attributes[tel.MEMORY_USER_ID] == "u1"
    assert span.attributes[tel.MEMORY_CUBE_ID] == "cube1"


def test_tier_constants_match_semconv():
    """Tier names must be stable identifiers for downstream consumers."""
    assert tel.TIER_TEXTUAL == "textual"
    assert tel.TIER_ACTIVATION == "activation"
    assert tel.TIER_PARAMETRIC == "parametric"
    assert tel.TIER_PREFERENCE == "preference"


def test_memory_span_all_operations(in_memory_providers):
    span_exporter, _ = in_memory_providers

    for op in ("add", "search", "update", "delete"):
        with tel.memory_span(op, tel.TIER_TEXTUAL):
            pass

    spans = span_exporter.get_finished_spans()
    assert len(spans) == 4
    ops = {s.attributes[tel.MEMORY_OPERATION] for s in spans}
    assert ops == {"add", "search", "update", "delete"}
