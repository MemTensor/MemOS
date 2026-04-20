"""Tests for fast-mode chunking in SimpleStructMemReader.

Covers:
  - chunk_text_by_tokens: paragraph→sentence→token fallback, overlap, idempotency.
  - _process_chat_data fast branch: short content → 1 memory; long content →
    multiple TextualMemoryItems with chunk_index/chunk_total in metadata.info.
  - Determinism for write-time dedup (same input → same chunks → same embeddings).
"""

import os
import unittest

from unittest.mock import MagicMock, patch

from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.mem_reader.utils import (
    chunk_text_by_tokens,
    count_tokens_text,
)
from memos.memories.textual.item import TextualMemoryItem


class TestChunkTextByTokens(unittest.TestCase):
    def test_short_text_single_chunk(self):
        text = "Short note about Paris."
        chunks = chunk_text_by_tokens(text, max_tokens=500, overlap_tokens=50)
        self.assertEqual(chunks, [text])

    def test_empty_text_no_chunks(self):
        self.assertEqual(chunk_text_by_tokens("", 500, 50), [])

    def test_long_text_multi_chunk(self):
        # ~3000 tokens of repeated paragraphs.
        para = (
            "The quick brown fox jumps over the lazy dog. " * 20
        )  # ~200 tokens per para
        text = "\n\n".join(para for _ in range(15))
        chunks = chunk_text_by_tokens(text, max_tokens=500, overlap_tokens=50)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            # Allow small slack: overlap + last unit may push slightly over.
            self.assertLess(count_tokens_text(c), 700)

    def test_overlap_present_between_chunks(self):
        text = "\n\n".join(
            f"Paragraph {i} about topic {i}: " + "word " * 100 for i in range(20)
        )
        chunks = chunk_text_by_tokens(text, max_tokens=300, overlap_tokens=50)
        self.assertGreater(len(chunks), 1)
        # Each non-first chunk should start with overlap from the previous chunk.
        for i in range(1, len(chunks)):
            tail = chunks[i - 1][-200:]
            head = chunks[i][:200]
            self.assertTrue(
                any(token in head for token in tail.split()[-5:]),
                f"chunk {i} missing overlap from chunk {i - 1}",
            )

    def test_deterministic_for_dedup(self):
        text = "\n\n".join(f"Para {i} " + "word " * 50 for i in range(20))
        c1 = chunk_text_by_tokens(text, 400, 40)
        c2 = chunk_text_by_tokens(text, 400, 40)
        self.assertEqual(c1, c2)

    def test_giant_single_sentence_falls_through_to_token_slice(self):
        # No paragraph or sentence breaks — must still chunk.
        text = ("word " * 4000).strip()
        chunks = chunk_text_by_tokens(text, max_tokens=300, overlap_tokens=30)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertTrue(c.strip())


class TestFastModeExpansion(unittest.TestCase):
    def setUp(self):
        self.config = MagicMock(spec=SimpleStructMemReaderConfig)
        self.config.llm = MagicMock()
        self.config.general_llm = None
        self.config.embedder = MagicMock()
        self.config.chunker = MagicMock()
        self.config.remove_prompt_example = MagicMock()

        with (
            patch.object(LLMFactory, "from_config", return_value=MagicMock()),
            patch.object(EmbedderFactory, "from_config", return_value=MagicMock()),
            patch.object(ChunkerFactory, "from_config", return_value=MagicMock()),
        ):
            self.reader = SimpleStructMemReader(self.config)

        # Embedder returns a fixed-shape vector so _make_memory_item succeeds.
        self.reader.embedder = MagicMock()
        self.reader.embedder.embed.side_effect = lambda xs: [[0.1] * 4 for _ in xs]

    def _info(self):
        return {"user_id": "u1", "session_id": "s1"}

    def test_short_content_yields_single_memory(self):
        msgs = [{"role": "user", "content": "Short note about Paris.", "chat_time": ""}]
        nodes = self.reader._process_chat_data(msgs, self._info(), mode="fast")
        self.assertEqual(len(nodes), 1)
        self.assertIsInstance(nodes[0], TextualMemoryItem)
        # No chunk metadata when there is only one chunk.
        info = nodes[0].metadata.info or {}
        self.assertNotIn("chunk_index", info)
        self.assertNotIn("chunk_total", info)

    def test_long_content_yields_multiple_chunks_with_metadata(self):
        long_content = ("The quick brown fox jumps over the lazy dog. " * 600).strip()
        msgs = [{"role": "user", "content": long_content, "chat_time": ""}]
        with patch.dict(
            os.environ,
            {"MOS_FAST_CHUNK_TOKENS": "500", "MOS_FAST_CHUNK_OVERLAP_TOKENS": "50"},
        ):
            nodes = self.reader._process_chat_data(msgs, self._info(), mode="fast")
        self.assertGreater(len(nodes), 1)
        totals = {(n.metadata.info or {}).get("chunk_total") for n in nodes}
        self.assertEqual(len(totals), 1, f"inconsistent chunk_total: {totals}")
        indices = sorted((n.metadata.info or {}).get("chunk_index") for n in nodes)
        self.assertEqual(indices, list(range(len(nodes))))

    def test_env_override_changes_chunk_count(self):
        long_content = ("The quick brown fox jumps over the lazy dog. " * 600).strip()
        msgs = [{"role": "user", "content": long_content, "chat_time": ""}]
        with patch.dict(
            os.environ,
            {"MOS_FAST_CHUNK_TOKENS": "200", "MOS_FAST_CHUNK_OVERLAP_TOKENS": "20"},
        ):
            small_chunks = self.reader._process_chat_data(
                msgs, self._info(), mode="fast"
            )
        with patch.dict(
            os.environ,
            {"MOS_FAST_CHUNK_TOKENS": "1000", "MOS_FAST_CHUNK_OVERLAP_TOKENS": "100"},
        ):
            big_chunks = self.reader._process_chat_data(
                msgs, self._info(), mode="fast"
            )
        self.assertGreater(len(small_chunks), len(big_chunks))

    def test_repeat_write_produces_identical_chunk_text(self):
        # Dedup runs on embeddings of identical text — verify the chunking
        # itself is deterministic so repeat writes hit the dedup path.
        long_content = ("The quick brown fox jumps over the lazy dog. " * 600).strip()
        msgs = [{"role": "user", "content": long_content, "chat_time": ""}]
        with patch.dict(
            os.environ,
            {"MOS_FAST_CHUNK_TOKENS": "500", "MOS_FAST_CHUNK_OVERLAP_TOKENS": "50"},
        ):
            run_a = self.reader._process_chat_data(msgs, self._info(), mode="fast")
            run_b = self.reader._process_chat_data(msgs, self._info(), mode="fast")
        a_texts = sorted(n.memory for n in run_a)
        b_texts = sorted(n.memory for n in run_b)
        self.assertEqual(a_texts, b_texts)


if __name__ == "__main__":
    unittest.main()
