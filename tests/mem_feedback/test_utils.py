import pytest

from memos.mem_feedback.utils import (
    estimate_tokens,
    extract_bracket_content,
    extract_square_brackets_content,
    general_split_into_chunks,
    make_mem_item,
    should_keep_update,
)


def test_estimate_tokens_returns_zero_for_empty_text():
    assert estimate_tokens("") == 0


def test_estimate_tokens_counts_mixed_language_text():
    assert estimate_tokens("hello memory 世界") > 0


def test_should_keep_update_rejects_unchanged_text():
    assert not should_keep_update("same memory", "same memory")


def test_should_keep_update_accepts_small_edit():
    old_text = "the user prefers concise answers"
    new_text = "the user prefers concise answers with examples"

    assert should_keep_update(new_text, old_text)


def test_should_keep_update_rejects_large_rewrite():
    assert not should_keep_update("zzzzzzzzzz", "aaaaaaaaaa")


def test_general_split_into_chunks_groups_small_items():
    chunks = general_split_into_chunks(
        [{"text": "short"}, {"text": "also short"}],
        max_tokens_per_chunk=100,
    )

    assert chunks == [[{"text": "short"}, {"text": "also short"}]]


def test_extract_bracket_content_parses_json_payload():
    assert extract_bracket_content('prefix {"operation": "ADD", "text": "memory"} suffix') == {
        "operation": "ADD",
        "text": "memory",
    }


def test_extract_square_brackets_content_parses_json_payload():
    assert extract_square_brackets_content('prefix [{"operation": "UPDATE"}] suffix') == [
        {"operation": "UPDATE"}
    ]


def test_extract_bracket_content_raises_for_missing_payload():
    with pytest.raises(ValueError, match="No curly brace content"):
        extract_bracket_content("no json here")


def test_make_mem_item_carries_feedback_metadata():
    item = make_mem_item(
        "prefers concise answers",
        info={"user_id": "user-1", "session_id": "session-1", "app_id": "app-1"},
        user_name="alice",
        tags=["feedback"],
        key="answer_style",
        embedding=[0.1, 0.2],
        sources=[{"type": "feedback", "content": "too long"}],
        background="from user feedback",
        type="fine",
    )

    assert item.memory == "prefers concise answers"
    assert item.metadata.user_id == "user-1"
    assert item.metadata.session_id == "session-1"
    assert item.metadata.user_name == "alice"
    assert item.metadata.tags == ["feedback"]
    assert item.metadata.key == "answer_style"
    assert item.metadata.embedding == [0.1, 0.2]
    assert item.metadata.info == {"app_id": "app-1"}
