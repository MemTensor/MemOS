from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.embedders.base import BaseEmbedder
from memos.exceptions import EmbedderError
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


class TruncatingEmbedder(BaseEmbedder):
    def __init__(self, limit: int):
        self.config = SimpleNamespace(max_tokens=limit)
        self.submitted_texts = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        texts = self._truncate_texts(texts)
        self.submitted_texts.extend(texts)
        return [[0.1] for _ in texts]


def make_reader(embedder):
    reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)
    reader.embedder = embedder
    reader.chat_window_max_tokens = 100
    reader._count_tokens = lambda text: len(text.split())
    reader.chunker = Mock()
    reader.chunker.chunk.side_effect = lambda text: [text]
    return reader


def make_item(text: str) -> TextualMemoryItem:
    return TextualMemoryItem(
        memory=text,
        metadata=TreeNodeTextualMemoryMetadata(
            sources=[SourceMessage(content=text, role="user", message_id="sample-1")],
        ),
    )


def test_windows_cover_the_tail_without_embedder_truncation():
    embedder = TruncatingEmbedder(limit=16)
    reader = make_reader(embedder)
    text = "alpha beta gamma delta epsilon omega"

    windows = reader._concat_multi_modal_memories([make_item(text)])

    assert len(windows) > 1
    assert "".join(window.memory for window in windows) == text
    assert embedder.submitted_texts == [window.memory for window in windows]
    assert all(window.metadata.embedding for window in windows)
    assert all(window.metadata.sources[0].message_id == "sample-1" for window in windows)


def test_failed_single_retry_cannot_leave_a_writeable_partial_batch():
    embedder = Mock()
    embedder.embed.side_effect = [RuntimeError("batch"), [[0.1]], RuntimeError("single")]
    reader = make_reader(embedder)
    items = [make_item("first"), make_item("second")]

    with pytest.raises(EmbedderError):
        reader._embed_memory_items(items)

    assert [item.metadata.embedding for item in items] == [None, None]


def test_empty_vector_cannot_pass_the_public_reader_boundary(monkeypatch):
    embedder = Mock()
    embedder.embed.return_value = [[]]
    reader = make_reader(embedder)
    monkeypatch.setattr(
        reader,
        "_process_multi_modal_data",
        lambda scenes, info, **kwargs: reader._concat_multi_modal_memories([make_item("sample")]),
    )

    with pytest.raises(EmbedderError):
        reader.get_memory(
            [[{"role": "user", "content": "sample"}]],
            "chat",
            {"user_id": "sample-user", "session_id": "sample-session"},
            mode="fast",
        )
