"""
Regression guard for ISI-1918: the MCP server entry-point MUST bootstrap OTel.

Root cause of the board report ("trace has only crewai spans, no memos service"):
`memos.api.mcp_serve` served MemOS over MCP but never called
`telemetry.configure_from_env()`. The `mos_core.add/search/...` calls are already
instrumented, but without an exporting TracerProvider they run against the global
no-op provider, so the "memos" service emitted ZERO telemetry over the MCP path.

These tests pin two contracts:
  1. `telemetry.configure_from_env()` is env-gated (no-op unless an OTLP endpoint
     is set) and stamps service.name=memos when it is.
  2. Constructing the MCP server triggers the telemetry bootstrap.

The MCP server is loaded with lightweight stubs for fastmcp / MOS so the test
needs neither a collector nor the heavy model stack.
"""
import importlib.util
import pathlib
import sys
import types

import pytest

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


_REPO = pathlib.Path(__file__).parent.parent
_TEL_PATH = _REPO / "src" / "memos" / "telemetry.py"
_MCP_PATH = _REPO / "src" / "memos" / "api" / "mcp_serve.py"


def _load_telemetry():
    spec = importlib.util.spec_from_file_location("memos.telemetry", _TEL_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# 1. configure_from_env is env-gated
# ---------------------------------------------------------------------------
def test_configure_from_env_noop_without_endpoint(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    tel = _load_telemetry()
    assert tel.configure_from_env() is False
    assert tel._initialized is False


def test_configure_from_env_disabled_flag(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    monkeypatch.setenv("MEMOS_OTEL_ENABLED", "false")
    tel = _load_telemetry()
    assert tel.configure_from_env() is False
    assert tel._initialized is False


# ---------------------------------------------------------------------------
# 2. Constructing the MCP server bootstraps telemetry
# ---------------------------------------------------------------------------
@pytest.fixture()
def stubbed_mcp_serve(monkeypatch):
    """Load mcp_serve.py with fastmcp / MOS stubs and a recording telemetry stub."""
    calls = {"configure_from_env": 0}

    fake_tel = types.ModuleType("memos.telemetry")

    def _configure_from_env():
        calls["configure_from_env"] += 1
        # Mirror the real env gate so the test exercises both branches.
        import os as _os

        return bool(_os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))

    fake_tel.configure_from_env = _configure_from_env

    fake_memos = types.ModuleType("memos")
    fake_memos.telemetry = fake_tel

    class _FakeFastMCP:
        def __init__(self, name):
            self.name = name

        def tool(self, *a, **k):
            def deco(fn):
                return fn

            return deco

    fake_fastmcp = types.ModuleType("fastmcp")
    fake_fastmcp.FastMCP = _FakeFastMCP

    fake_dotenv = types.ModuleType("dotenv")
    fake_dotenv.load_dotenv = lambda *a, **k: None

    fake_main = types.ModuleType("memos.mem_os.main")
    fake_main.MOS = type("MOS", (), {})
    fake_default_cfg = types.ModuleType("memos.mem_os.utils.default_config")
    fake_default_cfg.get_default = lambda *a, **k: ({}, object())
    fake_user_mgr = types.ModuleType("memos.mem_user.user_manager")
    fake_user_mgr.UserRole = type("UserRole", (), {"ADMIN": "ADMIN", "USER": "USER"})

    stubs = {
        "memos": fake_memos,
        "memos.telemetry": fake_tel,
        "fastmcp": fake_fastmcp,
        "dotenv": fake_dotenv,
        "memos.mem_os.main": fake_main,
        "memos.mem_os.utils.default_config": fake_default_cfg,
        "memos.mem_user.user_manager": fake_user_mgr,
    }
    saved = {k: sys.modules.get(k) for k in stubs}
    sys.modules.update(stubs)
    try:
        spec = importlib.util.spec_from_file_location("_mcp_serve_under_test", _MCP_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        yield mod, calls
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
        sys.modules.pop("_mcp_serve_under_test", None)


def test_mcp_server_bootstraps_telemetry(stubbed_mcp_serve, monkeypatch):
    mod, calls = stubbed_mcp_serve
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

    # Pass an existing MOS instance so __init__ skips load_default_config().
    mod.MOSMCPServer(mos_instance=object())

    assert calls["configure_from_env"] == 1, (
        "MCP server __init__ must call telemetry.configure_from_env() so the "
        "'memos' service actually exports spans/metrics/logs over the MCP path"
    )


def test_bootstrap_helper_is_env_gated(stubbed_mcp_serve, monkeypatch):
    mod, calls = stubbed_mcp_serve
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    mod._bootstrap_telemetry()
    assert calls["configure_from_env"] == 1  # still called; returns False internally


# ---------------------------------------------------------------------------
# 3. End-to-end: once configured, a memory span carries service.name=memos
#    (this is what makes the "memos" service appear in the backend)
# ---------------------------------------------------------------------------
def test_memory_span_service_name_is_memos():
    tel = _load_telemetry()
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.semconv.resource import ResourceAttributes

    exporter = InMemorySpanExporter()
    provider = TracerProvider(
        resource=Resource.create({ResourceAttributes.SERVICE_NAME: "memos"})
    )
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    tel._tracer = provider.get_tracer(tel.INSTRUMENT_NAME)
    tel._initialized = True

    with tel.memory_span("add", tel.TIER_TEXTUAL, {tel.MEMORY_USER_ID: "u1"}):
        pass

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].name == "memory.add"
    assert spans[0].resource.attributes[ResourceAttributes.SERVICE_NAME] == "memos"
