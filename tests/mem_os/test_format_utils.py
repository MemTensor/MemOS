"""
Test suite for src/memos/mem_os/utils/format_utils.py

Focus: clean_json_response function defensive behavior
Related issues: #1525, #2420
"""

import json

import pytest

from memos.mem_os.utils.format_utils import clean_json_response


class TestCleanJsonResponse:
    """Test clean_json_response function with various inputs."""

    def test_clean_json_response_with_none_raises_value_error(self):
        """Test that passing None raises ValueError with diagnostic message."""
        with pytest.raises(ValueError) as exc_info:
            clean_json_response(None)

        error_message = str(exc_info.value)
        assert "clean_json_response received None" in error_message
        assert "upstream LLM call" in error_message
        assert "timed_with_status" in error_message or "generate()" in error_message

    def test_clean_json_response_removes_json_code_block(self):
        """Test removal of ```json markers."""
        input_str = '```json\n{"key": "value"}\n```'
        expected = '{"key": "value"}'
        assert clean_json_response(input_str) == expected

    def test_clean_json_response_removes_plain_code_block(self):
        """Test removal of ``` markers without json keyword."""
        input_str = '```\n{"key": "value"}\n```'
        expected = '{"key": "value"}'
        assert clean_json_response(input_str) == expected

    def test_clean_json_response_strips_whitespace(self):
        """Test that leading/trailing whitespace is stripped."""
        input_str = '  \n  {"key": "value"}  \n  '
        expected = '{"key": "value"}'
        assert clean_json_response(input_str) == expected

    def test_clean_json_response_handles_plain_json(self):
        """Test that plain JSON without markdown is unchanged (except strip)."""
        input_str = '{"key": "value"}'
        expected = '{"key": "value"}'
        assert clean_json_response(input_str) == expected

    def test_clean_json_response_handles_empty_string(self):
        """Test that empty string is handled correctly."""
        assert clean_json_response("") == ""

    def test_clean_json_response_with_complex_json(self):
        """Test with realistic LLM response containing nested JSON."""
        input_str = """```json
{
    "queries": [
        {"query": "test", "weight": 1.0},
        {"query": "example", "weight": 0.5}
    ]
}
```"""
        result = clean_json_response(input_str)
        assert "```json" not in result
        assert '"queries"' in result
        assert result.strip() == result  # No leading/trailing whitespace

    def test_clean_json_response_preserves_internal_backticks(self):
        """Test that single backticks inside JSON content are preserved."""
        input_str = '```json\n{"code": "`example`"}\n```'
        result = clean_json_response(input_str)
        assert "`example`" in result
        assert result.count("`") == 2  # Only internal backticks remain

    def test_clean_json_response_preserves_interior_code_fence(self):
        """Regression for issue #2420.

        A JSON string value that itself contains a fenced ```py ... ``` block
        must survive untouched — only the outer ```json / ``` wrapper is markup.
        """
        input_str = '```json\n{"text": "```py\\ncode```"}\n```'
        result = clean_json_response(input_str)
        parsed = json.loads(result)
        assert parsed == {"text": "```py\ncode```"}

    def test_clean_json_response_preserves_interior_code_fence_no_wrapper(self):
        """Bare JSON containing an interior ``` fence must be returned as-is."""
        input_str = '{"text": "```py\\ncode```"}'
        result = clean_json_response(input_str)
        parsed = json.loads(result)
        assert parsed == {"text": "```py\ncode```"}

    def test_clean_json_response_preserves_interior_json_fence(self):
        """A JSON value quoting the literal string ```json must survive."""
        input_str = '```json\n{"snippet": "see ```json blocks```"}\n```'
        result = clean_json_response(input_str)
        parsed = json.loads(result)
        assert parsed == {"snippet": "see ```json blocks```"}

    def test_clean_json_response_leaves_unwrapped_response_untouched(self):
        """Response with no wrapping fence at all is only whitespace-stripped."""
        input_str = '  {"answer": "```code```"}  '
        result = clean_json_response(input_str)
        parsed = json.loads(result)
        assert parsed == {"answer": "```code```"}

    def test_clean_json_response_requires_closing_fence_on_own_line(self):
        """A trailing ``` must be preceded by a newline to count as a fence.

        Guards against a JSON string value that legitimately ends with
        triple-backticks being mistaken for a closing fence — only a fence
        on its own line (``\\n``` ``) is recognised.
        """
        # Opening fence + JSON whose last value ends in ``` + closing fence
        # on its own line: interior fence must survive intact.
        input_str = '```json\n{"a": "x```"}\n```'
        result = clean_json_response(input_str)
        parsed = json.loads(result)
        assert parsed == {"a": "x```"}
