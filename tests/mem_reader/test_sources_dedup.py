from unittest.mock import Mock

import pytest

from memos.chunkers.simple_chunker import SimpleTextSplitter
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


@pytest.fixture
def reader():
    reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)
    reader.chunker = SimpleTextSplitter(chunk_size=4, chunk_overlap=0)
    reader._count_tokens = len
    reader.embedder = Mock()
    reader.embedder.embed.side_effect = lambda texts: [[0.1] for _ in texts]
    return reader


def make_item(text: str, *sources: SourceMessage) -> TextualMemoryItem:
    return TextualMemoryItem(
        memory=text,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="test-user",
            session_id="test-session",
            memory_type="UserMemory",
            sources=list(sources),
        ),
    )


def test_window_deduplicates_nested_provenance_in_source_order(reader):
    source = SourceMessage(
        type="doc",
        doc_path="sample.md",
        content="A paragraph.",
        file_info={"locator": {"pages": [1, 2], "offset": 4}},
        span=[{"start": 4, "end": 16}],
    )
    duplicate = SourceMessage(
        type="doc",
        doc_path="sample.md",
        content="A paragraph.",
        file_info={"locator": {"offset": 4, "pages": [1, 2]}},
        span=[{"end": 16, "start": 4}],
    )
    different_span = duplicate.model_copy(update={"span": [{"start": 20, "end": 32}]})
    different_page_order = duplicate.model_copy(
        update={"file_info": {"locator": {"pages": [2, 1], "offset": 4}}}
    )

    window = reader._build_window_from_items(
        [
            make_item("first", source),
            make_item("second", duplicate, different_span, different_page_order),
        ],
        {},
    )

    assert window.metadata.sources == [source, different_span, different_page_order]


def test_long_message_keeps_one_source_per_window(reader):
    text = "aaaabbbbccccdddd"
    source = SourceMessage(type="chat", role="user", content=text, message_id="msg-1")

    windows = reader._concat_multi_modal_memories(
        [make_item(text, source)], max_tokens=10, overlap=0
    )

    assert [window.memory for window in windows] == ["aaaabbbb", "ccccdddd"]
    assert [window.metadata.sources for window in windows] == [[source], [source]]
    assert [window.metadata.memory_type for window in windows] == ["UserMemory", "UserMemory"]


def test_window_keeps_identical_text_from_distinct_messages(reader):
    first = SourceMessage(role="user", content="yes", message_id="msg-1")
    second = SourceMessage(role="assistant", content="yes", message_id="msg-2")

    window = reader._build_window_from_items(
        [make_item("first", first), make_item("second", second, first.model_copy())], {}
    )

    assert window.metadata.sources == [first, second]
    assert window.metadata.memory_type == "LongTermMemory"
