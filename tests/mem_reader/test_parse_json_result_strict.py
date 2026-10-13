"""Regression tests for issue #2456.

``parse_json_result`` previously swallowed every JSON-decode failure and
returned ``{}``, so a malformed LLM extraction was indistinguishable from a
successful empty extraction. Downstream callers saw ``{"code": 200, "data": []}``
for ``/product/add`` requests that actually failed.

These tests pin the new contract: ``parse_json_result`` raises
``LLMResponseParseError`` on any non-recoverable parse failure, and only
returns the parsed dict on success (including a literal ``{}``).

The tests import ``memos.mem_reader.utils`` and ``memos.exceptions`` directly
so they don't need the full ``memos`` import chain (LLM/embedder/reranker
backends) to load.
"""

from __future__ import annotations

import importlib.util
import sys
import types

import pytest


# --- minimal package stubs so memos.mem_reader.utils can import memos.log ---
# ``memos.exceptions`` does not depend on the heavy stack, but the test module
# also pulls in ``memos.mem_reader.utils`` which uses ``memos.log.get_logger``.
# We stub the parts we touch to keep this test self-contained.
def _load_memos_submodules():
    pkg_root = types.ModuleType("memos")
    pkg_root.__path__ = ["src/memos"]
    sys.modules["memos"] = pkg_root

    exc_spec = importlib.util.spec_from_file_location("memos.exceptions", "src/memos/exceptions.py")
    exc_mod = importlib.util.module_from_spec(exc_spec)
    sys.modules["memos.exceptions"] = exc_mod
    exc_spec.loader.exec_module(exc_mod)

    log_mod = types.ModuleType("memos.log")

    class _StubLogger:
        def warning(self, *args, **kwargs):
            return None

        def error(self, *args, **kwargs):
            return None

        def info(self, *args, **kwargs):
            return None

        def debug(self, *args, **kwargs):
            return None

    def _get_logger(name):
        return _StubLogger()

    log_mod.get_logger = _get_logger
    sys.modules["memos.log"] = log_mod

    mem_reader_pkg = types.ModuleType("memos.mem_reader")
    mem_reader_pkg.__path__ = ["src/memos/mem_reader"]
    sys.modules["memos.mem_reader"] = mem_reader_pkg

    util_spec = importlib.util.spec_from_file_location(
        "memos.mem_reader.utils", "src/memos/mem_reader/utils.py"
    )
    util_mod = importlib.util.module_from_spec(util_spec)
    sys.modules["memos.mem_reader.utils"] = util_mod
    util_spec.loader.exec_module(util_mod)

    return exc_mod, util_mod


_EXC, _UTILS = _load_memos_submodules()
LLMResponseParseError = _EXC.LLMResponseParseError
parse_json_result = _UTILS.parse_json_result


class TestParseJsonResultSuccess:
    def test_returns_parsed_object(self):
        raw = '{"memory list": [{"value": "hi"}], "summary": "s"}'
        result = parse_json_result(raw)
        assert result == {"memory list": [{"value": "hi"}], "summary": "s"}

    def test_returns_empty_object(self):
        raw = "{}"
        result = parse_json_result(raw)
        assert result == {}

    def test_strips_markdown_fences(self):
        raw = '```json\n{"summary": "s"}\n```'
        result = parse_json_result(raw)
        assert result == {"summary": "s"}


class TestParseJsonResultRaises:
    def test_trailing_comma_raises(self):
        # Issue #2456 reproducer: trailing comma is invalid JSON.
        raw = '{"memory list": [{"value": "synthetic evidence"}],}'
        with pytest.raises(LLMResponseParseError) as exc_info:
            parse_json_result(raw)
        assert exc_info.value.__cause__ is not None or "Failed" in str(exc_info.value)

    def test_no_json_object_raises(self):
        with pytest.raises(LLMResponseParseError):
            parse_json_result("not-valid-json")

    def test_unclosed_fence_raises(self):
        with pytest.raises(LLMResponseParseError):
            parse_json_result("```json\n{unterminated")

    def test_empty_string_raises(self):
        with pytest.raises(LLMResponseParseError):
            parse_json_result("")

    def test_none_input_raises(self):
        with pytest.raises(LLMResponseParseError):
            parse_json_result(None)

    def test_chatter_only_raises(self):
        # Mirrors the symptom-level scenario from #1493 / #2456: the LLM
        # emits only prose. The function must not silently return ``{}``.
        with pytest.raises(LLMResponseParseError):
            parse_json_result("Here is what I extracted: ... unfortunately I cannot output JSON.")

    def test_exception_chain_preserves_root_decode_error(self):
        with pytest.raises(LLMResponseParseError) as exc_info:
            parse_json_result('{"x": "unterminated')
        # The trailing warning message and chained cause let operators
        # debug the underlying JSON error from the original LLM payload.
        assert exc_info.value.__cause__ is not None
