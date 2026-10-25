"""Unit tests for the shared judge-reply parser.

The bug (#2525) is that LongMemEval's `lme_grader` applied `json.loads`
directly to the judge's chat completion, which fails whenever the model
follows the prompt and emits "<one sentence of reasoning>\n{<label json>}".
These tests pin the behaviour of the shared `parse_judge_label` helper that
both LongMemEval and LoCoMo now consume.
"""

from __future__ import annotations

import os
import sys

import pytest


# Make `evaluation/scripts/` importable without installing the eval group.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_EVAL_SCRIPTS = os.path.join(_REPO_ROOT, "evaluation", "scripts")
if _EVAL_SCRIPTS not in sys.path:
    sys.path.insert(0, _EVAL_SCRIPTS)

from utils.judge import extract_label_json, parse_judge_label  # noqa: E402


class TestExtractLabelJson:
    def test_raw_json_object(self):
        assert extract_label_json('{"label": "CORRECT"}') == '{"label": "CORRECT"}'

    def test_prose_then_json_from_issue_2525(self):
        """The exact shape of the judge reply described in the bug report."""
        text = 'The generated answer matches the gold answer.\n{"label": "CORRECT"}'
        extracted = extract_label_json(text)
        assert extracted == '{"label": "CORRECT"}'

    def test_single_quoted_value_still_matches(self):
        """LoCoMo's regex requires the ``"label"`` key double-quoted but
        accepts single OR double quotes around the value. Keep that behaviour."""
        assert extract_label_json("{\"label\": 'correct'}") == "{\"label\": 'correct'}"

    def test_empty_string_returns_none(self):
        assert extract_label_json("") is None

    def test_none_input_returns_none(self):
        assert extract_label_json(None) is None

    def test_text_without_label_returns_none(self):
        assert extract_label_json("The model refused to answer.") is None


class TestParseJudgeLabel:
    def test_raw_json_returns_label(self):
        assert parse_judge_label('{"label": "CORRECT"}') == "CORRECT"

    def test_prose_plus_json_returns_label(self):
        """The exact reproduction from issue #2525."""
        text = 'The generated answer matches the gold answer.\n{"label": "CORRECT"}'
        assert parse_judge_label(text) == "CORRECT"

    def test_wrong_label_round_trip(self):
        text = 'Different topic.\n{"label": "WRONG"}'
        assert parse_judge_label(text) == "WRONG"

    def test_empty_content_raises_value_error_with_preview(self):
        """Empty replies and prose-with-no-label replies must be distinguishable
        in the error message, per the bug report's log-collapse complaint."""
        with pytest.raises(ValueError) as excinfo:
            parse_judge_label("")
        # Message should mention the preview so operators can tell which input
        # tripped it; empty string preview must be visible.
        assert "preview" in str(excinfo.value).lower() or "''" in str(excinfo.value)

    def test_none_content_raises_value_error(self):
        with pytest.raises(ValueError):
            parse_judge_label(None)

    def test_no_label_raises_value_error_with_preview_substring(self):
        with pytest.raises(ValueError) as excinfo:
            parse_judge_label("The model said no answer could be given.")
        assert "The model said no answer" in str(excinfo.value)

    def test_long_content_preview_is_truncated(self):
        """200-byte preview cap, per the design doc."""
        with pytest.raises(ValueError) as excinfo:
            parse_judge_label("X" * 5000)
        # Preview truncation keeps log lines bounded.
        assert len(str(excinfo.value)) < 2000
