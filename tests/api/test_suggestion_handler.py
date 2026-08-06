"""Tests for suggestion_handler message structure fixes (Issue #1527)."""

from unittest.mock import Mock

from memos.api.handlers.suggestion_handler import (
    _get_further_suggestion,
    handle_get_suggestion_queries,
)


def test_handle_get_suggestion_queries_message_structure():
    """Test that handle_get_suggestion_queries uses system + user message structure."""
    mock_llm = Mock()
    mock_llm.generate.return_value = '{"query": ["test1", "test2", "test3"]}'

    mock_mem_cube = Mock()
    mock_mem_cube.text_mem.search.return_value = []

    handle_get_suggestion_queries(
        user_id="test_user",
        language="en",
        message=None,
        llm=mock_llm,
        naive_mem_cube=mock_mem_cube,
    )

    # Verify llm.generate was called
    assert mock_llm.generate.call_count == 1

    # Get the message_list passed to llm.generate
    call_args = mock_llm.generate.call_args
    message_list = call_args[0][0]

    # Verify message structure: should have system + user messages
    assert len(message_list) >= 2, "Message list should contain at least system + user messages"
    assert message_list[0]["role"] == "system", "First message should be system role"
    assert message_list[1]["role"] == "user", "Second message should be user role"

    # Verify system message is a short persona, not full instructions
    system_content = message_list[0]["content"]
    assert len(system_content) < 200, "System message should be brief persona"

    # Verify user message contains the actual instructions
    user_content = message_list[1]["content"]
    assert len(user_content) > 100, "User message should contain full instructions"
    assert "{memories}" not in user_content, "User message should have memories formatted"


def test_get_further_suggestion_message_structure():
    """Test that _get_further_suggestion uses system + user message structure."""
    mock_llm = Mock()
    mock_llm.generate.return_value = '{"query": ["suggestion1", "suggestion2"]}'

    test_messages = [
        {"role": "user", "content": "What's the weather?"},
        {"role": "assistant", "content": "It's sunny today."},
    ]

    result = _get_further_suggestion(mock_llm, test_messages)

    # Verify llm.generate was called
    assert mock_llm.generate.call_count == 1

    # Get the message_list passed to llm.generate
    call_args = mock_llm.generate.call_args
    message_list = call_args[0][0]

    # Verify message structure
    assert len(message_list) >= 2, "Message list should contain at least system + user messages"
    assert message_list[0]["role"] == "system", "First message should be system role"
    assert message_list[1]["role"] == "user", "Second message should be user role"

    # Verify result
    assert result == ["suggestion1", "suggestion2"]


def test_handle_get_suggestion_queries_zh_message_structure():
    """Test Chinese language path also uses correct message structure."""
    mock_llm = Mock()
    mock_llm.generate.return_value = '{"query": ["测试1", "测试2", "测试3"]}'

    mock_mem_cube = Mock()
    mock_mem_cube.text_mem.search.return_value = []

    handle_get_suggestion_queries(
        user_id="test_user",
        language="zh",
        message=None,
        llm=mock_llm,
        naive_mem_cube=mock_mem_cube,
    )

    # Get the message_list
    call_args = mock_llm.generate.call_args
    message_list = call_args[0][0]

    # Verify structure
    assert len(message_list) >= 2
    assert message_list[0]["role"] == "system"
    assert message_list[1]["role"] == "user"


def test_handle_get_suggestion_queries_with_further_message():
    """Test that further suggestion path uses correct message structure."""
    mock_llm = Mock()
    mock_llm.generate.return_value = '{"query": ["next1", "next2"]}'

    mock_mem_cube = Mock()

    test_messages = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
    ]

    handle_get_suggestion_queries(
        user_id="test_user",
        language="en",
        message=test_messages,
        llm=mock_llm,
        naive_mem_cube=mock_mem_cube,
    )

    # Get the message_list
    call_args = mock_llm.generate.call_args
    message_list = call_args[0][0]

    # Verify structure
    assert len(message_list) >= 2
    assert message_list[0]["role"] == "system"
    assert message_list[1]["role"] == "user"
