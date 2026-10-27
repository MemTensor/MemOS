"""Regression tests for issue #2456.

``parse_json_result`` previously swallowed every JSON-decode failure and
returned ``{}``, so a malformed LLM extraction was indistinguishable from a
successful empty extraction. Downstream callers saw ``{"code": 200, "data": []}``
for ``/product/add`` requests that actually failed.

These tests pin the new contract: ``parse_json_result`` raises
``LLMResponseParseError`` on any non-recoverable parse failure, and only
returns the parsed dict on success (including a literal ``{}``).
"""

from __future__ import annotations

import json

import pytest

from memos.exceptions import LLMResponseParseError
from memos.mem_reader.utils import parse_json_result


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
        assert isinstance(exc_info.value.__cause__, json.JSONDecodeError)

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
        assert isinstance(exc_info.value.__cause__, json.JSONDecodeError)
