"""Regression tests for issue #2453.

``MultiModalStructMemReader._split_large_memory_item`` previously passed
``sources=item.metadata.sources or []`` to ``_make_memory_item`` for every
chunk, so each chunk item carried the full list of source messages from the
parent. With N chunks and a parent carrying N original sources, every chunk
ended up with N byte-identical full-text ``SourceMessage`` objects — a
multiplicative duplication of memory and graph size that scaled with the
square of how chunked a message was.

These tests pin the new contract: each split chunk item's ``sources`` list
must not contain the parent's sources. Provenance of split chunks is
already carried on ``metadata.internal_info`` via ``chunk_index`` /
``chunk_total`` / ``ingest_batch_id`` (see
``MultiModalStructMemReader._split_large_memory_item``).
"""

from __future__ import annotations

import unittest

from unittest.mock import MagicMock

from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


def _build_parent_item(sources: list[SourceMessage]) -> TextualMemoryItem:
    return TextualMemoryItem(
        memory="long " * 200,  # > parent's token threshold
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="user-1",
            session_id="session-1",
            memory_type="LongTermMemory",
            sources=sources,
            info={},
            internal_info={},
        ),
    )


def _build_reader(chunks: list[str]) -> MultiModalStructMemReader:
    """Construct a minimal MultiModalStructMemReader with a mock chunker.

    The real constructor pulls in the full LLM/embedder stack; for this
    targeted test we bypass __init__ and attach only the attributes that
    ``_split_large_memory_item`` touches.
    """
    reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)

    class _Chunk:
        def __init__(self, text):
            self.text = text

    reader.chunker = MagicMock()
    reader.chunker.chunk = MagicMock(return_value=[_Chunk(t) for t in chunks])
    # Force the splitter to enter the chunking branch.
    reader._count_tokens = MagicMock(return_value=10_000)
    # The inherited ``_make_memory_item`` calls the embedder only when
    # need_embed=True; ``_split_large_memory_item`` already sets it False,
    # so a no-op embedder is sufficient.
    reader.embedder = MagicMock()
    reader.embedder.embed = MagicMock(return_value=[[0.0]])
    return reader


class TestSplitSourcesNotDuplicated(unittest.TestCase):
    """Pins issue #2453: split chunks must not carry the parent's sources."""

    def test_split_chunks_do_not_carry_parent_sources(self):
        parent_sources = [
            SourceMessage(type="chat", role="user", content=f"msg {i}") for i in range(4)
        ]
        parent = _build_parent_item(parent_sources)
        reader = _build_reader(["chunk 1", "chunk 2", "chunk 3"])

        chunks = reader._split_large_memory_item(parent, max_tokens=512)

        self.assertEqual(len(chunks), 3)
        for chunk in chunks:
            # Each carry is a TextualMemoryItem produced by ``_make_memory_item``.
            self.assertIsInstance(chunk, TextualMemoryItem)
            self.assertEqual(
                chunk.metadata.sources,
                [],
                f"split chunk must not carry parent's sources; got "
                f"{len(chunk.metadata.sources or [])} source(s)",
            )

    def test_split_chunks_preserve_provenance_via_internal_info(self):
        """The parent-id/chunk-index provenance must still be populated so
        downstream consumers can reconstruct chunk ordering."""
        parent_sources = [
            SourceMessage(type="chat", role="user", content=f"msg {i}") for i in range(3)
        ]
        parent = _build_parent_item(parent_sources)
        reader = _build_reader(["chunk 1", "chunk 2"])

        chunks = reader._split_large_memory_item(parent, max_tokens=512)

        self.assertEqual(len(chunks), 2)
        for idx, chunk in enumerate(chunks):
            self.assertIsNotNone(chunk.metadata.internal_info)
            self.assertEqual(chunk.metadata.internal_info["chunk_index"], idx)
            self.assertEqual(chunk.metadata.internal_info["chunk_total"], 2)
            self.assertIn("ingest_batch_id", chunk.metadata.internal_info)


if __name__ == "__main__":
    unittest.main()
