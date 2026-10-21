"""Tests for evaluation/scripts/PrefEval/pref_memos.py.

These tests pin the row-preservation contract described in
openspec/changes/2026-10-21-2526-prefeval-drops-a-sample-when-search-returns-no-text-memories/spec.md:

- An empty ``text_mem`` list is a valid "no retrieved text memories" state,
  not an error, and the row must still be emitted downstream.
- A search exception annotates the row with an ``error`` field (and empty
  ``retrieved_memories_text``) instead of dropping it.
- A response-generation exception annotates the row with an ``error`` field
  and sets ``response = ""`` so ``pref_eval.py`` can run the judge.
"""

from __future__ import annotations

import json
import os
import sys

from unittest.mock import MagicMock


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EVAL_SCRIPTS_DIR = os.path.join(REPO_ROOT, "evaluation", "scripts")
EVAL_PREFEVAL_DIR = os.path.join(EVAL_SCRIPTS_DIR, "PrefEval")

# The script relies on sibling-import semantics (``from irrelevant_conv import ...``
# and ``from utils.prompts import ...``). Mirror the same sys.path plumbing the
# script does at runtime so the module is importable in the test process.
for _path in (EVAL_PREFEVAL_DIR, EVAL_SCRIPTS_DIR, REPO_ROOT):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import pref_memos  # noqa: E402  (sys.path mutation above is intentional)


def _line_data(payload: dict) -> tuple[int, str]:
    return (0, json.dumps(payload))


def test_search_memory_for_line_returns_sample_when_text_mem_empty():
    """Empty ``text_mem`` must not crash and must not drop the row."""
    mem_client = MagicMock()
    mem_client.search.return_value = {"text_mem": [], "pref_string": "pref-A"}
    payload = {
        "user_id": "u1",
        "question": "What should I study?",
        "metrics": {},
        "preference": "likes math",
    }

    result = pref_memos.search_memory_for_line(_line_data(payload), mem_client, top_k_value=10)

    assert result is not None, "sample must not be dropped when text_mem is empty"
    assert "error" not in result, "empty text_mem is a valid state, not an error"
    # The format is "<joined memories>\n<pref_string>", so an empty memories
    # list yields a leading newline followed by the pref_string.
    assert result["metrics"]["retrieved_memories_text"] == "\npref-A"
    # Timing / token metrics should still be present.
    assert "search_memories_duration_seconds" in result["metrics"]
    assert result["metrics"]["memory_tokens_used"] >= 0
    # Top-level fields are preserved.
    assert result["user_id"] == "u1"
    assert result["question"] == "What should I study?"
    assert result["preference"] == "likes math"


def test_search_memory_for_line_returns_sample_with_error_on_exception():
    """Any exception from mem_client.search must keep the row (with error)."""
    mem_client = MagicMock()
    mem_client.search.side_effect = RuntimeError("boom")
    payload = {
        "user_id": "u1",
        "question": "Q",
        "metrics": {},
    }

    result = pref_memos.search_memory_for_line(_line_data(payload), mem_client, top_k_value=10)

    assert result is not None, "search exception must not cause row to be dropped"
    assert "error" in result
    assert "boom" in result["error"]
    # Response stage looks for retrieved_memories_text to decide whether to proceed.
    assert result["metrics"]["retrieved_memories_text"] == ""


def test_generate_response_for_line_returns_sample_with_error_on_api_failure():
    """OpenAI exception must keep the row with response="" and error annotated."""
    openai_client = MagicMock()
    openai_client.chat.completions.create.side_effect = RuntimeError("HTTP 503")
    payload = {
        "user_id": "u1",
        "question": "Q",
        "preference": "p",
        "metrics": {"retrieved_memories_text": ""},
    }

    result = pref_memos.generate_response_for_line(_line_data(payload), openai_client, "memos-api")

    assert result is not None, "API error must not cause row to be dropped"
    assert "error" in result
    assert "503" in result["error"]
    # pref_eval.py reads data["response"] - the key must exist.
    assert "response" in result, "pref_eval.py requires 'response' key on every row"
    assert result["response"] == ""


def test_generate_response_for_line_passes_through_search_error_with_empty_response():
    """A row that already carries an ``error`` from search must still get a ``response`` key.

    Without this, ``pref_eval.py`` fails ``data["response"]`` lookup on
    pass-through rows and the sample is silently dropped at the judge stage.
    """
    openai_client = MagicMock()
    payload = {
        "user_id": "u1",
        "question": "Q",
        "preference": "p",
        "error": "search_error: something bad",
        "metrics": {},
    }

    result = pref_memos.generate_response_for_line(_line_data(payload), openai_client, "memos-api")

    assert result is not None
    assert result["error"] == "search_error: something bad"
    assert result.get("response", None) == ""
    # Must not have tried to call OpenAI for an already-flagged row.
    openai_client.chat.completions.create.assert_not_called()


def test_search_memory_for_line_happy_path_unchanged():
    """Populated text_mem produces the same output format as before."""
    mem_client = MagicMock()
    mem_client.search.return_value = {
        "text_mem": [
            {
                "memories": [
                    {"memory": "likes math"},
                    {"memory": "dislikes seafood"},
                ]
            }
        ],
        "pref_string": "pref-string-X",
    }
    payload = {"user_id": "u1", "question": "Q", "metrics": {}}

    result = pref_memos.search_memory_for_line(_line_data(payload), mem_client, top_k_value=10)

    assert result is not None
    assert result["metrics"]["retrieved_memories_text"] == (
        "- likes math\n- dislikes seafood\npref-string-X"
    )
