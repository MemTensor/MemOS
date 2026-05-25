import unittest

from unittest.mock import MagicMock, patch

from memos.chunkers.factory import ChunkerFactory
from memos.configs.chunker import ChunkerConfigFactory


class TestSentenceChunker(unittest.TestCase):
    def test_sentence_chunker(self):
        """Test SentenceChunker functionality with mocked backend."""
        with patch("chonkie.SentenceChunker") as mock_chunker_cls:
            # Set up the mock for SentenceChunker
            mock_chunker = MagicMock()
            mock_chunks = [
                MagicMock(
                    text="This is the first sentence.",
                    token_count=6,
                    sentences=["This is the first sentence."],
                ),
                MagicMock(
                    text="This is the second sentence.",
                    token_count=6,
                    sentences=["This is the second sentence."],
                ),
            ]
            mock_chunker.chunk.return_value = mock_chunks
            mock_chunker_cls.return_value = mock_chunker

            # Create chunker via factory
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
            chunker = ChunkerFactory.from_config(config)

            # Test chunking
            text = "This is the first sentence. This is the second sentence."
            chunks = chunker.chunk(text)

            self.assertEqual(len(chunks), 2)
            # Validate the properties of the first chunk
            mock_chunker.chunk.assert_called_once_with(text)

            # Handle both return types: list[str] | list[Chunk]
            if isinstance(chunks[0], str):
                # If returns list[str], check the string value
                self.assertEqual(chunks[0], "This is the first sentence.")
                self.assertEqual(chunks[1], "This is the second sentence.")
            else:
                # If returns list[Chunk], check the Chunk properties
                from memos.chunkers.base import Chunk

                self.assertIsInstance(chunks[0], Chunk)
                self.assertEqual(chunks[0].text, "This is the first sentence.")
                self.assertEqual(chunks[0].token_count, 6)
                self.assertEqual(chunks[0].sentences, ["This is the first sentence."])

    def test_sentence_chunker_falls_back_to_character(self):
        """Falls back to 'character' tokenizer when the configured one cannot be loaded.

        Regression: in environments without tiktoken and without HuggingFace
        access, chonkie raises ValueError trying to load tokenizers like
        'gpt2'. The chunker should recover by falling back to chonkie's
        built-in 'character' counter instead of propagating the error.
        """
        mock_instance = MagicMock()

        def side_effect(*args, **kwargs):
            # New API (chonkie >=1.4.0) uses 'tokenizer='.
            if "tokenizer" in kwargs:
                raise TypeError("unexpected keyword argument 'tokenizer'")
            value = kwargs.get("tokenizer_or_token_counter")
            if value == "character":
                return mock_instance
            raise ValueError(f"Tokenizer not found in transformers/tokenizers/tiktoken: {value}")

        with patch("chonkie.SentenceChunker", side_effect=side_effect) as mock_chunker_cls:
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
            chunker = ChunkerFactory.from_config(config)

        self.assertIs(chunker.chunker, mock_instance)
        # Last call should be the 'character' fallback.
        self.assertEqual(
            mock_chunker_cls.call_args.kwargs.get("tokenizer_or_token_counter"),
            "character",
        )

    def test_sentence_chunker_no_warning_when_character_configured(self):
        """When 'character' is explicitly configured, no fallback warning is emitted.

        Guards against a regression where the fallback warning fires for
        users who deliberately picked the character counter.
        """
        import logging

        def side_effect(*args, **kwargs):
            if "tokenizer" in kwargs:
                raise TypeError("unexpected keyword argument 'tokenizer'")
            return MagicMock()

        records: list[logging.LogRecord] = []

        class _Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        handler = _Capture(level=logging.WARNING)
        logger_under_test = logging.getLogger("memos.chunkers.sentence_chunker")
        logger_under_test.addHandler(handler)
        try:
            with patch("chonkie.SentenceChunker", side_effect=side_effect):
                config = ChunkerConfigFactory.model_validate(
                    {
                        "backend": "sentence",
                        "config": {
                            "tokenizer_or_token_counter": "character",
                            "chunk_size": 10,
                        },
                    }
                )
                ChunkerFactory.from_config(config)
        finally:
            logger_under_test.removeHandler(handler)

        fallback_warnings = [r for r in records if "falling back to 'character'" in r.getMessage()]
        self.assertEqual(
            fallback_warnings,
            [],
            f"Unexpected fallback warning when 'character' was configured: {fallback_warnings}",
        )
