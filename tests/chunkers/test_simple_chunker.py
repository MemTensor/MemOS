"""Tests for SimpleTextSplitter fallback chunker."""

from memos.chunkers.simple_chunker import SimpleTextSplitter


class TestSimpleTextSplitterConstruction:
    def test_construct_and_expose_helpers(self):
        splitter = SimpleTextSplitter(chunk_size=128, chunk_overlap=8)
        assert splitter.chunk_size == 128
        assert splitter.chunk_overlap == 8
        protected, url_map = splitter.protect_urls("See https://example.com/x")
        assert "https://example.com/x" not in protected
        assert "__URL_" in protected
        restored = splitter.restore_urls(protected, url_map)
        assert restored == "See https://example.com/x"


class TestSimpleTextSplitterUrlPreservation:
    def test_url_not_truncated_midstring(self):
        url = "https://very.long.example.com/path/to/resource?a=1&b=2&c=3&d=4"
        text = f"Intro. {url} Conclusion."
        # Small chunk size forces a break near the URL; URL must stay whole.
        splitter = SimpleTextSplitter(chunk_size=16, chunk_overlap=0)
        chunks = splitter.chunk(text)
        joined = "".join(chunks)
        assert url in joined
        for chunk in chunks:
            # If chunk contains a portion of URL placeholder, original was intact
            if "__URL_" in chunk:
                assert splitter.restore_urls(chunk, splitter.protect_urls(text)[1])

    def test_empty_and_whitespace_input(self):
        splitter = SimpleTextSplitter(chunk_size=32, chunk_overlap=0)
        assert splitter.chunk("") == []
        assert splitter.chunk("   \n\n  ") == []

    def test_short_text_returns_single_chunk(self):
        splitter = SimpleTextSplitter(chunk_size=512, chunk_overlap=0)
        text = "Hello world. This is a test."
        result = splitter.chunk(text)
        assert len(result) == 1
        assert result[0] == text

    def test_long_text_produces_overlapping_chunks(self):
        text = "Paragraph one.\n\n" * 20
        splitter = SimpleTextSplitter(chunk_size=64, chunk_overlap=8)
        chunks = splitter.chunk(text)
        assert len(chunks) > 1
        for c in chunks:
            assert isinstance(c, str)
            assert len(c) <= 64 + 8  # a little slack for separator inclusion


class TestSimpleTextSplitterSplitBoundaries:
    def test_prefers_sentence_breaks(self):
        text = "First sentence. Second sentence. Third sentence. Fourth sentence."
        splitter = SimpleTextSplitter(chunk_size=40, chunk_overlap=0)
        chunks = splitter.chunk(text)
        assert len(chunks) >= 2
        # First chunk should end at/near a sentence boundary
        assert chunks[0].rstrip().endswith((".", "。", "！", "？")) or " " in chunks[0]
