import logging
import sys
import types

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest


SRC_DIR = Path(__file__).resolve().parents[2] / "src" / "memos"


def _install_memos_package_stub() -> None:
    """Only fill in the pieces that are missing so the real package, when
    importable, is never shadowed for the rest of the test session."""
    if "memos" not in sys.modules:
        memos_pkg = types.ModuleType("memos")
        memos_pkg.__path__ = [str(SRC_DIR)]
        sys.modules["memos"] = memos_pkg

    if "memos.log" not in sys.modules:
        log_stub = types.ModuleType("memos.log")
        log_stub.get_logger = logging.getLogger
        sys.modules["memos.log"] = log_stub
        sys.modules["memos"].log = log_stub

    if "memos.chunkers" not in sys.modules:
        chunkers_pkg = types.ModuleType("memos.chunkers")
        chunkers_pkg.__path__ = [str(SRC_DIR / "chunkers")]
        sys.modules["memos.chunkers"] = chunkers_pkg
        sys.modules["memos"].chunkers = chunkers_pkg


@pytest.fixture
def sentence_chunker() -> Any:
    _install_memos_package_stub()

    with patch("chonkie.SentenceChunker"):
        from memos.chunkers.factory import ChunkerFactory
        from memos.configs.chunker import ChunkerConfigFactory

        config = ChunkerConfigFactory.model_validate(
            {
                "backend": "sentence",
                "config": {
                    "tokenizer_or_token_counter": "gpt2",
                    "chunk_size": 10,
                    "chunk_overlap": 2,
                },
            }
        )
        return ChunkerFactory.from_config(config)


def test_chunk_returns_chunk_objects_with_restored_urls(sentence_chunker):
    from memos.chunkers.base import Chunk

    # chunk() protects URLs first, so the placeholder form is what the
    # backend sees and what the returned Chunk must have restored
    backend_chunks = [
        MagicMock(
            text="Read __URL_0__ for details.",
            token_count=6,
            sentences=["Read __URL_0__ for details."],
        )
    ]
    sentence_chunker.chunker = MagicMock()
    sentence_chunker.chunker.chunk.return_value = backend_chunks

    chunks = sentence_chunker.chunk("Read https://example.com/a-very-long-url for details.")

    assert len(chunks) == 1
    # the method must return real Chunk objects, not the bare restored string
    assert isinstance(chunks[0], Chunk)
    assert chunks[0].text == "Read https://example.com/a-very-long-url for details."
    assert chunks[0].token_count == 6
    assert chunks[0].sentences == ["Read __URL_0__ for details."]
