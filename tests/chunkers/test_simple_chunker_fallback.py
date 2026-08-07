"""Regression tests for `SimpleTextSplitter` fallback (issue #2115).

The fallback is exercised in production when `langchain_text_splitters` is
missing (ACK image drift). Prior to the fix, `SimpleTextSplitter.chunk()`
raised `AttributeError: 'SimpleTextSplitter' object has no attribute
'protect_urls'` because `_simple_split_text` referenced `self.protect_urls`
/ `self.restore_urls`, which are only defined on `BaseChunker`.
"""

from types import SimpleNamespace

import pytest

from memos.chunkers.base import BaseChunker
from memos.chunkers.simple_chunker import SimpleTextSplitter


def test_simple_text_splitter_inherits_base_chunker():
    splitter = SimpleTextSplitter(chunk_size=512, chunk_overlap=128)

    assert isinstance(splitter, BaseChunker)


def test_simple_text_splitter_short_text_with_url_returns_single_chunk():
    """Short text below chunk_size should return one chunk with the URL intact."""
    splitter = SimpleTextSplitter(chunk_size=512, chunk_overlap=128)
    text = "This is a test document with a URL: https://example.com/path/to/resource"

    chunks = splitter.chunk(text)

    assert chunks == [text]


def test_simple_text_splitter_long_text_preserves_url():
    """A URL must never be split across chunks — it either appears whole or not at all in a chunk.

    The critical property (issue #2115): even after fallback splitting, we
    must never see a chunk that contains only part of a URL. Overlap MAY
    cause the same URL to appear in more than one chunk; that is by design
    for retrieval quality and is not what the issue asks us to change.
    """
    url = "https://example.com/very/long/path/segment?query=one&other=two#fragment"
    prefix = "A" * 400
    suffix = "B" * 400
    text = f"{prefix} {url} {suffix}"

    splitter = SimpleTextSplitter(chunk_size=200, chunk_overlap=50)
    chunks = splitter.chunk(text)

    assert len(chunks) > 1, "text should be split into multiple chunks"
    # The URL must appear whole at least once.
    assert any(url in c for c in chunks), (
        f"URL was fully lost after splitting; chunks (first 5)={chunks[:5]}"
    )
    # No chunk should contain the placeholder marker leftover.
    for c in chunks:
        assert BaseChunker._URL_PLACEHOLDER_PREFIX not in c, (
            f"unresolved URL placeholder leaked into chunk: {c!r}"
        )
    # No chunk should contain a *partial* URL — i.e., if the chunk mentions
    # "https://" it must contain the URL in full.
    for c in chunks:
        if "https://" in c:
            assert url in c, f"chunk contains a partial URL: {c!r}"


def test_simple_text_splitter_does_not_cut_placeholder_at_chunk_boundary():
    """A raw chunk boundary inside a placeholder must be moved to a safe edge."""
    url = "https://example.com/path"
    text = "A" * 95 + url + " " + "B" * 120
    splitter = SimpleTextSplitter(chunk_size=100, chunk_overlap=20)

    chunks = splitter.chunk(text)

    assert any(url in chunk for chunk in chunks)
    assert all(BaseChunker._URL_PLACEHOLDER_PREFIX not in chunk for chunk in chunks)
    assert all("https://" not in chunk or url in chunk for chunk in chunks)
    assert len(chunks) < 10, "splitter made insufficient progress around the URL boundary"


def test_simple_text_splitter_stops_after_emitting_final_chunk():
    """The final overlap must not be emitted repeatedly as shrinking suffixes."""
    splitter = SimpleTextSplitter(chunk_size=100, chunk_overlap=20)

    chunks = splitter.chunk("X" * 150)

    assert chunks == ["X" * 100, "X" * 70]


def test_simple_text_splitter_empty_input_returns_empty_list():
    splitter = SimpleTextSplitter(chunk_size=100, chunk_overlap=20)
    assert splitter.chunk("") == []
    assert splitter.chunk("   \n  \t ") == []


def test_simple_text_splitter_no_url_still_chunks():
    splitter = SimpleTextSplitter(chunk_size=50, chunk_overlap=10)
    text = "Hello world. " * 20  # > 50 chars, no URL
    chunks = splitter.chunk(text)
    assert len(chunks) >= 2
    # Reassembling should recover all non-whitespace content.
    joined = "".join(chunks)
    for word in ["Hello", "world"]:
        assert word in joined


@pytest.mark.parametrize(
    ("chunk_size", "overlap"),
    [(100, 20), (256, 64), (1024, 128)],
)
def test_simple_text_splitter_various_sizes_do_not_raise(chunk_size, overlap):
    """The fallback used to raise AttributeError for *any* input containing a URL."""
    splitter = SimpleTextSplitter(chunk_size=chunk_size, chunk_overlap=overlap)
    text = "prefix " + ("word " * 200) + "https://example.com/x " + ("tail " * 200)
    # Must not raise.
    chunks = splitter.chunk(text)
    assert isinstance(chunks, list)
    assert all(isinstance(c, str) for c in chunks)


def test_simple_text_splitter_preserves_literal_placeholder_text():
    """URL restoration must not rewrite placeholder-like user content."""
    splitter = SimpleTextSplitter(chunk_size=512, chunk_overlap=128)
    text = "literal __URL_0__ then https://example.com/x"

    assert splitter.chunk(text) == [text]


def test_simple_text_splitter_preserves_placeholder_like_text_inside_url():
    """Restoring one URL must not rewrite text inside another URL."""
    splitter = SimpleTextSplitter(chunk_size=512, chunk_overlap=128)
    text = "first https://a.example/__URL_1__ then https://b.example/path"

    assert splitter.chunk(text) == [text]


@pytest.mark.parametrize(
    "text",
    [
        "literal __URL_0__ then https://example.com/x",
        "first https://a.example/__URL_1__ then https://b.example/path",
        "https://one.example/a https://two.example/b https://three.example/c",
    ],
)
def test_url_protection_round_trip_preserves_exact_input(text):
    splitter = SimpleTextSplitter(chunk_size=512, chunk_overlap=128)

    protected_text, url_map = splitter.protect_urls(text)

    assert all(placeholder not in text for placeholder in url_map)
    assert splitter.restore_urls(protected_text, url_map) == text


def test_url_protection_retries_colliding_dynamic_namespace(monkeypatch):
    generated_uuids = iter(
        [
            SimpleNamespace(hex="deadbeef" * 4),
            SimpleNamespace(hex="feedface" * 4),
        ]
    )
    monkeypatch.setattr("memos.chunkers.base.uuid.uuid4", lambda: next(generated_uuids))
    splitter = SimpleTextSplitter(chunk_size=512, chunk_overlap=128)
    text = "literal __URL_deadbeef_0__ then https://example.com/x"

    protected_text, url_map = splitter.protect_urls(text)

    assert list(url_map) == ["__URL_feedface_0__"]
    assert splitter.restore_urls(protected_text, url_map) == text


@pytest.mark.parametrize(
    ("chunk_size", "overlap", "message"),
    [
        (0, 0, "chunk_size must be greater than 0"),
        (-1, 0, "chunk_size must be greater than 0"),
        (100, -1, "chunk_overlap must be non-negative"),
        (100, 100, "chunk_overlap must be smaller than chunk_size"),
        (100, 101, "chunk_overlap must be smaller than chunk_size"),
    ],
)
def test_simple_text_splitter_rejects_invalid_sizes(chunk_size, overlap, message):
    with pytest.raises(ValueError, match=message):
        SimpleTextSplitter(chunk_size=chunk_size, chunk_overlap=overlap)
