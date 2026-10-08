"""Regression tests for issue #2453:
    `sources` array must not be duplicated across chunks when a large memory
    item is split.

Covers two layers of the fix:
  * `_split_large_memory_item` attaches the parent `sources` list only to
    the chunk-0 ("owning") sub-item. Non-owning chunks get `sources=[]`.
  * `_build_window_from_items` deduplicates `sources` by a stable
    (type, role, message_id, chat_time, doc_path, content) signature so
    that even if upstream re-introduces duplicates, the aggregated window
    carries at most one copy per unique origin message.
"""

from __future__ import annotations

import unittest

from unittest.mock import MagicMock, patch

from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


def _make_fast_item(
    memory: str = "User said hello",
    user_id: str = "u1",
    session_id: str = "sess1",
    role: str = "user",
    sources: list | None = None,
    internal_info: dict | None = None,
) -> TextualMemoryItem:
    if sources is None:
        sources = [
            SourceMessage(
                type="chat",
                role=role,
                content=memory,
                message_id="msg-1",
                chat_time="2026-10-03T09:00:00Z",
            )
        ]
    return TextualMemoryItem(
        memory=memory,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=user_id,
            session_id=session_id,
            memory_type="LongTermMemory",
            sources=sources,
            internal_info=internal_info,
        ),
    )


def _fake_make_memory_item(
    *,
    value,
    info,
    memory_type,
    tags,
    key,
    sources,
    background,
    need_embed,
):
    """Thin stand-in for `_make_memory_item` that avoids touching the real
    embedder."""
    return TextualMemoryItem(
        memory=value,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=info.get("user_id", ""),
            session_id=info.get("session_id", ""),
            memory_type=memory_type,
            tags=tags,
            key=key,
            sources=sources,
            background=background,
        ),
    )


class TestSplitLargeItemSourcesNotDuplicated(unittest.TestCase):
    """`_split_large_memory_item` must not propagate full sources list to
    every chunk — only to the first (owning) chunk."""

    def setUp(self):
        with patch.object(MultiModalStructMemReader, "__init__", lambda self, *a, **kw: None):
            self.reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)
        self.reader.chunker = MagicMock()
        self.reader._make_memory_item = MagicMock(side_effect=_fake_make_memory_item)
        self.reader._count_tokens = MagicMock(return_value=9999)

    def test_only_first_chunk_inherits_sources(self):
        """Given a fast item with 1 source split into 4 chunks, chunk 0
        carries the source; chunks 1..3 carry sources=[]. Total sources
        across chunks == len(parent.sources)."""
        self.reader.chunker.chunk.return_value = [
            "chunk 1",
            "chunk 2",
            "chunk 3",
            "chunk 4",
        ]

        source = SourceMessage(
            type="chat",
            role="user",
            content="a" * 1456,
            message_id="msg-1456",
            chat_time="2026-10-03T09:00:00Z",
        )
        parent = _make_fast_item("a" * 1456, sources=[source])

        chunks = self.reader._split_large_memory_item(parent, max_tokens=10)

        self.assertEqual(len(chunks), 4, "chunker returned 4 chunks")

        # Chunk 0 is the owning chunk — carries the full source list.
        self.assertEqual(len(chunks[0].metadata.sources), 1)
        self.assertIs(chunks[0].metadata.sources[0], source)

        # Chunks 1..3 carry no sources (prevents multiplication).
        for i, chunk in enumerate(chunks[1:], start=1):
            self.assertEqual(
                len(chunk.metadata.sources),
                0,
                f"chunk {i} should have 0 sources, got {len(chunk.metadata.sources)}",
            )

        # Total count across all chunks == original source count.
        total = sum(len(c.metadata.sources) for c in chunks)
        self.assertEqual(
            total,
            1,
            f"Expected total sources across chunks == 1, got {total}. "
            "Each chunk should NOT copy the full parent sources list.",
        )

    def test_owning_chunk_marker_in_internal_info(self):
        """Owning chunk (chunk_index=0) must have source_chunk_index=0 in
        internal_info; non-owning chunks must NOT have this key."""
        self.reader.chunker.chunk.return_value = ["chunk 1", "chunk 2", "chunk 3"]

        parent = _make_fast_item("x" * 500, internal_info={"origin": "doc"})

        chunks = self.reader._split_large_memory_item(parent, max_tokens=10)

        self.assertEqual(len(chunks), 3)
        self.assertEqual(chunks[0].metadata.internal_info.get("source_chunk_index"), 0)
        for chunk in chunks[1:]:
            self.assertNotIn("source_chunk_index", chunk.metadata.internal_info or {})

        # Lineage keys preserved on every chunk.
        for chunk in chunks:
            self.assertIn("ingest_batch_id", chunk.metadata.internal_info)
            self.assertIn("chunk_index", chunk.metadata.internal_info)
            self.assertIn("chunk_total", chunk.metadata.internal_info)
            self.assertEqual(chunk.metadata.internal_info["chunk_total"], 3)
            # Pre-existing internal_info keys propagate.
            self.assertEqual(chunk.metadata.internal_info["origin"], "doc")

    def test_split_bails_before_marking_when_only_one_chunk(self):
        """If the chunker returns only 1 chunk the split path still returns
        1 item carrying the original sources. The single chunk IS the
        owning chunk (chunk_index=0), so ``source_chunk_index=0`` is also
        recorded in ``internal_info`` — this makes the owning-chunk marker
        uniformly discoverable regardless of chunk_total."""
        self.reader.chunker.chunk.return_value = ["only chunk"]
        source = SourceMessage(type="chat", role="user", content="hi")
        parent = _make_fast_item("hi", sources=[source])

        chunks = self.reader._split_large_memory_item(parent, max_tokens=10)

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].metadata.sources, [source])
        # Single chunk is also the owning chunk — marker must be present
        # so downstream consumers can locate the source-carrying chunk by
        # internal_info["source_chunk_index"] without a chunk_total probe.
        self.assertEqual(
            chunks[0].metadata.internal_info.get("source_chunk_index"), 0
        )


class TestBuildWindowDedupesSources(unittest.TestCase):
    """`_build_window_from_items` must deduplicate sources so that a
    sliding window containing N chunks that share one original source ends
    up with 1 source, not N."""

    def setUp(self):
        with patch.object(MultiModalStructMemReader, "__init__", lambda self, *a, **kw: None):
            self.reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)
        self.reader.embedder = MagicMock()
        self.reader.embedder.embed.return_value = [[0.1] * 8]

    def test_window_dedupes_identical_sources(self):
        """4 chunks each carrying the SAME SourceMessage must yield a
        window whose sources list has length 1 (not 4)."""
        shared_source = SourceMessage(
            type="chat",
            role="user",
            content="hello world",
            message_id="m-1",
            chat_time="2026-10-03T09:00:00Z",
        )
        items = [_make_fast_item(f"chunk {i}", sources=[shared_source]) for i in range(4)]

        window = self.reader._build_window_from_items(
            items, {"user_id": "u1", "session_id": "sess1"}
        )

        self.assertIsNotNone(window)
        self.assertEqual(
            len(window.metadata.sources),
            1,
            f"Expected 1 deduped source, got {len(window.metadata.sources)} — "
            "window is re-duplicating identical sources.",
        )

    def test_window_dedupes_structurally_identical_but_distinct_objects(self):
        """Two separate SourceMessage instances with identical fields
        must also dedupe — not just reference-equal ones."""
        s1 = SourceMessage(
            type="chat",
            role="user",
            content="hello world",
            message_id="m-1",
            chat_time="2026-10-03T09:00:00Z",
        )
        s2 = SourceMessage(
            type="chat",
            role="user",
            content="hello world",
            message_id="m-1",
            chat_time="2026-10-03T09:00:00Z",
        )
        self.assertIsNot(s1, s2, "test needs two distinct SourceMessage objects")

        items = [
            _make_fast_item("part A", sources=[s1]),
            _make_fast_item("part B", sources=[s2]),
        ]

        window = self.reader._build_window_from_items(
            items, {"user_id": "u1", "session_id": "sess1"}
        )

        self.assertIsNotNone(window)
        self.assertEqual(len(window.metadata.sources), 1)

    def test_window_keeps_distinct_sources(self):
        """Legitimately distinct sources must NOT be deduped."""
        s1 = SourceMessage(type="chat", role="user", content="first", message_id="m-1")
        s2 = SourceMessage(type="chat", role="user", content="second", message_id="m-2")

        items = [
            _make_fast_item("first", sources=[s1]),
            _make_fast_item("second", sources=[s2]),
        ]

        window = self.reader._build_window_from_items(
            items, {"user_id": "u1", "session_id": "sess1"}
        )

        self.assertIsNotNone(window)
        self.assertEqual(len(window.metadata.sources), 2)
        contents = {s.content for s in window.metadata.sources}
        self.assertEqual(contents, {"first", "second"})

    def test_window_keeps_sources_distinguished_by_extra_fields(self):
        """SourceMessage declares extra='allow', so two paragraphs from the
        same document that differ only in an extra locator (page, offset,
        span, …) must remain distinct after dedup. Both have
        ``message_id=None`` and identical core fields, so a 6-field
        signature would collapse them — regressing provenance granularity.
        See issue #2453 OCR follow-up."""
        s1 = SourceMessage(
            type="doc",
            role=None,
            content="paragraph body",
            message_id=None,
            doc_path="docs/handbook.md",
            page=12,
        )
        s2 = SourceMessage(
            type="doc",
            role=None,
            content="paragraph body",
            message_id=None,
            doc_path="docs/handbook.md",
            page=37,
        )

        items = [
            _make_fast_item("first", sources=[s1]),
            _make_fast_item("second", sources=[s2]),
        ]

        window = self.reader._build_window_from_items(
            items, {"user_id": "u1", "session_id": "sess1"}
        )

        self.assertIsNotNone(window)
        self.assertEqual(
            len(window.metadata.sources),
            2,
            "Sources that differ only in extra fields (e.g. page) must not "
            "be collapsed by the signature — provenance granularity lost.",
        )
        pages = {getattr(s, "page", None) for s in window.metadata.sources}
        self.assertEqual(pages, {12, 37})

    def test_window_role_detection_still_works_after_dedup(self):
        """Dedup must not break the role-based memory_type assignment
        (UserMemory when sources only contain `user` role) AND must retain
        the owning source. Without the sources-count assertion, a buggy
        dedup that strips the user-role source entirely would still leave
        ``roles`` empty — role detection then defaults away from
        ``assistant`` and the test passes as a false positive."""
        source = SourceMessage(type="chat", role="user", content="hi", message_id="m-1")
        items = [_make_fast_item(f"c{i}", sources=[source]) for i in range(3)]

        window = self.reader._build_window_from_items(
            items, {"user_id": "u1", "session_id": "sess1"}
        )

        self.assertIsNotNone(window)
        self.assertEqual(
            len(window.metadata.sources),
            1,
            "Dedup must retain exactly 1 source, not drop all",
        )
        self.assertEqual(window.metadata.memory_type, "UserMemory")


class TestEndToEndSourcesCountInvariant(unittest.TestCase):
    """End-to-end: a fast item fed through `_concat_multi_modal_memories`
    produces fast-mode windows whose sources are not duplicated."""

    def setUp(self):
        with patch.object(MultiModalStructMemReader, "__init__", lambda self, *a, **kw: None):
            self.reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)
        self.reader.embedder = MagicMock()
        self.reader.embedder.embed.return_value = [[0.1] * 8]
        self.reader.chunker = MagicMock()
        self.reader._make_memory_item = MagicMock(side_effect=_fake_make_memory_item)
        self.reader.chat_window_max_tokens = 10

    def test_long_message_produces_windows_with_single_source(self):
        """Reproduces the issue scenario: a single long message gets
        chunked into N; the resulting fast-mode windows must carry 1
        source each, not N."""
        # Simulate a long input: tokens high enough to trigger split.
        token_calls = {"n": 0}

        def fake_count(_text: str) -> int:
            token_calls["n"] += 1
            # First call = whole-item token check in _concat → returns big
            # subsequent calls (per-window cur_text) stay below the cap so
            # the sliding window happily puts all chunks into one window.
            return 999 if token_calls["n"] == 1 else 1

        self.reader._count_tokens = MagicMock(side_effect=fake_count)
        self.reader.chunker.chunk.return_value = ["c1", "c2", "c3", "c4"]

        shared_source = SourceMessage(
            type="chat",
            role="user",
            content="x" * 1456,
            message_id="msg-xxl",
            chat_time="2026-10-03T09:00:00Z",
        )
        parent = _make_fast_item("x" * 1456, sources=[shared_source])

        windows = self.reader._concat_multi_modal_memories([parent], max_tokens=10)

        self.assertTrue(len(windows) >= 1)
        # At least one window must carry the owning source. If dedup
        # over-collapses (or the owning chunk is dropped entirely),
        # every window ends up with `sources=[]` and the ≤ 1 check
        # alone would silently pass — defeating the regression guard.
        windows_with_sources = [w for w in windows if w.metadata.sources]
        self.assertGreaterEqual(
            len(windows_with_sources),
            1,
            "At least one window must carry the owning source; no window had any "
            "source — possible regression where the source is being dropped entirely.",
        )
        for w in windows:
            # The key assertion: no source multiplication.
            self.assertLessEqual(
                len(w.metadata.sources or []),
                1,
                f"Window carries {len(w.metadata.sources or [])} sources; "
                "expected ≤ 1 for a single-origin long message.",
            )


if __name__ == "__main__":
    unittest.main()
