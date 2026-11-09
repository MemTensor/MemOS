"""Regression tests for `CharacterTextChunker` URL handling (issue #2510).

`CharacterTextChunker` replaces URLs with `__URL_<n>__` placeholders before
splitting. `RecursiveCharacterTextSplitter` can cut through a placeholder
(e.g. ``__URL`` / ``_0__`` in different chunks), after which the URL can no
longer be restored and placeholder fragments leak into the output.

The fix reuses `SimpleTextSplitter` — which keeps placeholders indivisible
(see #2228) — for inputs that contain URLs, keeping the recursive path for
plain text.
"""

import pytest


langchain_text_splitters = pytest.importorskip("langchain_text_splitters")

from memos.chunkers.base import BaseChunker
from memos.chunkers.charactertext_chunker import CharacterTextChunker


URL = "https://example.com/install"
TEXT_WITH_URL = f"安装文档：{URL} 请查看。"


def _assert_url_intact(chunks: list[str], url: str = URL) -> None:
    """The URL must survive chunking whole; no placeholder fragments may leak."""
    assert any(url in chunk for chunk in chunks), (
        f"URL was fully lost after splitting; chunks={chunks}"
    )
    for chunk in chunks:
        assert BaseChunker._URL_PLACEHOLDER_PREFIX not in chunk, (
            f"unresolved URL placeholder leaked into chunk: {chunk!r}"
        )


def test_url_preserved_with_small_chunk_size():
    """Exact reproduction from issue #2510."""
    splitter = CharacterTextChunker(chunk_size=10, chunk_overlap=0)

    chunks = splitter.chunk(TEXT_WITH_URL)

    _assert_url_intact(chunks)


def test_url_preserved_with_overlap():
    """Overlap must not reintroduce split placeholders either."""
    splitter = CharacterTextChunker(chunk_size=12, chunk_overlap=4)

    chunks = splitter.chunk(TEXT_WITH_URL)

    _assert_url_intact(chunks)


def test_url_longer_than_chunk_size_preserved_whole():
    """A URL longer than chunk_size is kept whole (may oversize one chunk)."""
    long_url = "https://example.com/" + "a" * 120
    splitter = CharacterTextChunker(chunk_size=20, chunk_overlap=0)

    chunks = splitter.chunk(f"see {long_url} now")

    _assert_url_intact(chunks, url=long_url)


def test_multiple_urls_all_preserved():
    """Every URL in the input must survive, not just the first."""
    urls = ["https://example.com/one", "https://example.org/two"]
    splitter = CharacterTextChunker(chunk_size=10, chunk_overlap=0)

    chunks = splitter.chunk(f"first {urls[0]} then {urls[1]} end")

    for url in urls:
        _assert_url_intact(chunks, url=url)


def test_text_without_url_keeps_recursive_splitting():
    """Inputs without URLs must keep the previous recursive-splitter behavior."""
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    text = "第一段内容在这里。\n\n第二段内容在这里，稍微长一点。"
    splitter = CharacterTextChunker(chunk_size=10, chunk_overlap=0)

    chunks = splitter.chunk(text)
    expected = RecursiveCharacterTextSplitter(
        chunk_size=10,
        chunk_overlap=0,
        length_function=len,
        separators=["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " ", ""],
    ).split_text(text)

    assert chunks == expected
