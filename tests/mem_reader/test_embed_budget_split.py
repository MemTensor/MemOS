"""Regression tests for issue #2461.

A memory item whose token count sits in ``(embedder per-item limit,
chat_window_max_tokens]`` used to be neither split (the splitter only fired above
``chat_window_max_tokens``) nor embeddable (it exceeded the embedder's limit). The item
was still persisted, but with ``metadata.embedding is None`` and ``vector_sync !=
"success"``, so semantic search could never recall it — a silent no-vector write.

These tests pin the fix:

1. ``chat_window_max_tokens`` is an explicit, env-configurable config field.
2. The effective split budget is ``min(window, embedder limit)``.
3. ``_split_large_memory_item`` re-checks chunker output and hard-splits anything still
   over budget, so every text handed to the embedder fits.
4. ``_embed_memory_items`` truncates before per-item retry, so one over-limit item cannot
   leave a whole batch without embeddings.
"""

import unittest

from unittest.mock import MagicMock, patch

from pydantic import ValidationError

from memos.api.config import APIConfig
from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import (
    SimpleStructMemReaderConfig,
)
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.item import (
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


class _FakeEmbedder:
    """Embedder stub whose configured limit mirrors the real one.

    ``embed`` raises for any text whose character length exceeds ``limit``, which mimics a
    provider rejecting over-limit input, and returns a deterministic vector otherwise.
    """

    def __init__(self, limit: int = 10_000):
        self.config = MagicMock()
        self.config.max_tokens = limit
        self.limit = limit
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        for text in texts:
            if len(text) > self.limit:
                raise ValueError("input exceeds the embedder per-item limit")
        return [[float(len(t))] * 4 for t in texts]


def _make_item(memory: str, **internal_info) -> TextualMemoryItem:
    return TextualMemoryItem(
        memory=memory,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="u1",
            session_id="s1",
            memory_type="LongTermMemory",
            tags=[],
            key=None,
            sources=[],
            background="",
            internal_info=internal_info or None,
        ),
    )


def _reader_config_dict(window: int) -> dict:
    """Minimal valid mem_reader config dict (no optional providers)."""
    return {
        "llm": {
            "backend": "openai",
            "config": {"model_name_or_path": "gpt-4o", "api_key": "test-key"},
        },
        "embedder": {
            "backend": "ollama",
            "config": {"model_name_or_path": "nomic-embed-text:latest"},
        },
        "chunker": {
            "backend": "sentence",
            "config": {
                "tokenizer_or_token_counter": "gpt2",
                "chunk_size": 512,
                "chunk_overlap": 128,
                "min_sentences_per_chunk": 1,
                "save_rawfile": False,
            },
        },
        "chat_window_max_tokens": window,
    }


def _build_reader(
    embedder: _FakeEmbedder,
    window: int = 1024,
    chunker=None,
    cls=MultiModalStructMemReader,
):
    """Construct a reader with a mocked embedder/chunker and a lightweight config stub.

    ``MultiModalStructMemReader`` rebuilds a ``SimpleStructMemReaderConfig`` from
    ``config.model_dump()``, so the stub must return a dict the base config accepts.
    """
    cfg = MagicMock()
    cfg.model_dump.return_value = _reader_config_dict(window)
    cfg.chat_window_max_tokens = window
    cfg.remove_prompt_example = False
    cfg.general_llm = None
    cfg.preference_extractor_llm = None
    cfg.image_parser_llm = None
    cfg.document_parser_llm = None
    cfg.direct_markdown_hostnames = None
    cfg.oss_config = None
    cfg.skills_dir_config = None
    cfg.memory_version_switch = "off"

    with (
        patch.object(LLMFactory, "from_config", return_value=MagicMock()),
        patch.object(EmbedderFactory, "from_config", return_value=embedder),
        patch.object(ChunkerFactory, "from_config", return_value=chunker or MagicMock()),
    ):
        reader = cls(cfg)

    # MagicMock auto-attributes would make every budget look unlimited; be explicit.
    reader.embedder = embedder
    reader.chunker = chunker or MagicMock()
    reader.chat_window_max_tokens = window
    return reader


class TestEffectiveBudget(unittest.TestCase):
    """R2: the split budget honors the embedder's per-item limit."""

    def test_budget_capped_by_embedder_limit(self):
        reader = _build_reader(_FakeEmbedder(limit=512), window=1024)
        self.assertEqual(reader._get_embed_budget(), 512)

    def test_budget_uses_window_when_embedder_is_more_permissive(self):
        reader = _build_reader(_FakeEmbedder(limit=8192), window=1024)
        self.assertEqual(reader._get_embed_budget(), 1024)

    def test_budget_defaults_to_1024_without_config(self):
        reader = _build_reader(_FakeEmbedder(limit=8192))
        reader.chat_window_max_tokens = 1024
        self.assertEqual(reader._get_embed_budget(), 1024)

    def test_mock_embedder_has_no_limit(self):
        """A MagicMock config must not be mistaken for a real positive limit."""
        embedder = MagicMock()
        reader = _build_reader(embedder, window=1024)
        reader.embedder = embedder
        self.assertEqual(reader._get_embed_budget(), 1024)


class TestHardSplit(unittest.TestCase):
    """R3: post-chunker hard split guarantees every chunk fits."""

    def test_punctuation_free_cjk_paragraph_is_split_within_budget(self):
        reader = _build_reader(_FakeEmbedder(limit=10_000), window=512)
        # Punctuation-free CJK paragraph: the sentence chunker does not split it.
        text = "中" * 1170
        pieces = reader._hard_split_text(text, 512)

        self.assertGreaterEqual(len(pieces), 2)
        self.assertEqual("".join(pieces), text)
        for piece in pieces:
            self.assertLessEqual(reader._count_tokens(piece), 512)
            self.assertGreater(len(piece), 0)

    def test_split_prefers_punctuation_boundary(self):
        reader = _build_reader(_FakeEmbedder(limit=10_000), window=10)
        # "。" should be the cut point rather than an arbitrary character position.
        text = "一二三四五六七八九十。" + "x" * 40
        pieces = reader._hard_split_text(text, 10)
        self.assertTrue(pieces[0].endswith("。"), pieces[0])

    def test_empty_chunker_output_still_gets_split(self):
        """A chunker that yields nothing must not put the over-budget item through as-is.

        Returning the original item here would reproduce the silent no-vector bug, so the
        hard split takes over instead.
        """
        chunker = MagicMock()
        chunker.chunk.return_value = []
        reader = _build_reader(_FakeEmbedder(limit=10_000), window=5, chunker=chunker)
        reader._count_tokens = len
        item = _make_item("abcdefghij")

        result = reader._split_large_memory_item(item, max_tokens=5)

        self.assertGreater(len(result), 1)
        self.assertEqual("".join(it.memory for it in result), "abcdefghij")
        for it in result:
            self.assertLessEqual(len(it.memory), 5)

    def test_item_within_budget_is_untouched(self):
        chunker = MagicMock()
        reader = _build_reader(_FakeEmbedder(limit=10_000), window=1024, chunker=chunker)
        reader._count_tokens = len
        item = _make_item("short")

        result = reader._split_large_memory_item(item, max_tokens=1024)

        self.assertEqual(result, [item])
        chunker.chunk.assert_not_called()

    def test_chunker_output_expanded_and_indexed_contiguously(self):
        """A chunk the chunker failed to size must be hard-split and re-indexed."""
        chunker = MagicMock()
        # First chunk fits, second one is oversized and must be hard-split.
        chunker.chunk.return_value = ["a" * 4, "b" * 12]
        reader = _build_reader(_FakeEmbedder(limit=10_000), window=5, chunker=chunker)
        reader._count_tokens = len
        reader._make_memory_item = MagicMock(
            side_effect=lambda *, value, **kwargs: _make_item(value)
        )

        result = reader._split_large_memory_item(_make_item("x" * 20), max_tokens=5)

        self.assertGreater(len(result), 2)
        self.assertEqual(
            [it.metadata.internal_info["chunk_index"] for it in result],
            list(range(len(result))),
        )
        self.assertEqual({it.metadata.internal_info["chunk_total"] for it in result}, {len(result)})
        batch_ids = {it.metadata.internal_info["ingest_batch_id"] for it in result}
        self.assertEqual(len(batch_ids), 1)
        for it in result:
            self.assertLessEqual(len(it.memory), 5)


class TestConcatUsesEffectiveBudget(unittest.TestCase):
    """R4: the split trigger uses the effective budget, not the raw window."""

    def test_item_in_the_gap_is_split(self):
        chunker = MagicMock()
        chunker.chunk.return_value = []  # force the deterministic hard-split path
        reader = _build_reader(_FakeEmbedder(limit=512), window=1024, chunker=chunker)
        reader._count_tokens = len
        reader._make_memory_item = MagicMock(
            side_effect=lambda *, value, **kwargs: _make_item(value)
        )
        # 700 "tokens" of content: inside (512, 1024], previously never split.
        item = _make_item("z" * 700)

        result = reader._concat_multi_modal_memories([item])

        self.assertGreaterEqual(len(result), 2)
        for it in result:
            self.assertLessEqual(len(it.memory), 512)
            self.assertIsNotNone(it.metadata.embedding)


class TestEmbedFallback(unittest.TestCase):
    """R5: per-item retry truncates, so one bad item cannot zero out a batch."""

    def test_over_limit_item_still_gets_an_embedding(self):
        embedder = _FakeEmbedder(limit=10)
        reader = _build_reader(embedder, window=10)
        reader._count_tokens = len

        good = _make_item("short")
        bad = _make_item("q" * 100)

        calls: list[list[str]] = []

        def embed_impl(texts: list[str]) -> list[list[float]]:
            calls.append(list(texts))
            if len(texts) > 1:
                raise ValueError("batch call rejected by the provider")
            return [[1.0] * 4 for _ in texts]

        embedder.embed = MagicMock(side_effect=embed_impl)
        reader._embed_memory_items([good, bad])

        self.assertIsNotNone(good.metadata.embedding)
        self.assertIsNotNone(bad.metadata.embedding)
        # The retried text must have been truncated to the budget.
        retried = [c[0] for c in calls if len(c) == 1]
        self.assertTrue(retried)
        self.assertTrue(all(len(text) <= 10 for text in retried))
        self.assertTrue(any(len(text) == 10 for text in retried))


class TestConfigPlumbing(unittest.TestCase):
    """R1: config field default + env override reachable from the API layer."""

    def test_env_var_overrides_window(self):
        with patch.dict("os.environ", {"MEM_READER_CHAT_WINDOW_MAX_TOKENS": "512"}):
            self.assertEqual(APIConfig.get_chat_window_max_tokens(), 512)

    def test_env_var_defaults_to_1024(self):
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("MEM_READER_CHAT_WINDOW_MAX_TOKENS", None)
            self.assertEqual(APIConfig.get_chat_window_max_tokens(), 1024)

    def test_invalid_env_var_falls_back_to_1024(self):
        for raw in ("abc", "0", "-5", ""):
            with patch.dict("os.environ", {"MEM_READER_CHAT_WINDOW_MAX_TOKENS": raw}):
                self.assertEqual(APIConfig.get_chat_window_max_tokens(), 1024)

    def test_reader_config_field_has_default(self):
        field = SimpleStructMemReaderConfig.model_fields["chat_window_max_tokens"]
        self.assertEqual(field.default, 1024)

    def test_reader_config_rejects_non_positive_window(self):
        base = _reader_config_dict(1024)
        with self.assertRaises(ValidationError):
            SimpleStructMemReaderConfig(**{**base, "chat_window_max_tokens": 0})


class TestSimpleStructReaderUsesBudget(unittest.TestCase):
    """R5/P1: the base reader's single-text embedding path respects the budget."""

    def test_make_memory_item_truncates_over_budget_text(self):
        embedder = _FakeEmbedder(limit=10)
        reader = _build_reader(embedder, window=10, cls=SimpleStructMemReader)
        reader._count_tokens = len

        item = reader._make_memory_item(
            value="y" * 500,
            info={"user_id": "u1", "session_id": "s1"},
            memory_type="LongTermMemory",
        )

        self.assertIsNotNone(item.metadata.embedding)
        self.assertEqual(embedder.calls[-1][0], "y" * 10)

    def test_make_memory_item_within_budget_is_verbatim(self):
        embedder = _FakeEmbedder(limit=10_000)
        reader = _build_reader(embedder, window=1024, cls=SimpleStructMemReader)
        reader._count_tokens = len

        reader._make_memory_item(
            value="verbatim text",
            info={"user_id": "u1", "session_id": "s1"},
            memory_type="LongTermMemory",
        )

        self.assertEqual(embedder.calls[-1][0], "verbatim text")


if __name__ == "__main__":
    unittest.main()
