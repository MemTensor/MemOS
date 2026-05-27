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
        """When 'character' is explicitly configured, the initial build
        succeeds and no fallback warning is emitted.

        Mock setup: only ``character`` is accepted; any other value raises
        ``ValueError``. With ``character`` configured, the first iteration
        of the build loop succeeds, so the fallback branch is never
        entered — proving that a user who explicitly picked the character
        counter does not see the "Tokenizer 'character' unavailable;
        falling back to 'character'" warning.
        """
        import logging

        def side_effect(*args, **kwargs):
            if "tokenizer" in kwargs:
                value = kwargs["tokenizer"]
            elif "tokenizer_or_token_counter" in kwargs:
                value = kwargs["tokenizer_or_token_counter"]
            else:
                raise TypeError("no tokenizer kwarg")
            if value == "character":
                return MagicMock()
            raise ValueError(f"Tokenizer not found: {value}")

        records: list[logging.LogRecord] = []

        class _Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        handler = _Capture(level=logging.WARNING)
        logger_under_test = logging.getLogger("memos.chunkers.sentence_chunker")
        logger_under_test.addHandler(handler)
        try:
            with patch("chonkie.SentenceChunker", side_effect=side_effect) as mock_cls:
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

        # Sanity: chonkie was called exactly once (first build-loop
        # iteration succeeded), so the fallback path was never entered.
        self.assertEqual(mock_cls.call_count, 1)
        fallback_warnings = [r for r in records if "falling back to 'character'" in r.getMessage()]
        self.assertEqual(
            fallback_warnings,
            [],
            f"Unexpected fallback warning when 'character' was configured: {fallback_warnings}",
        )

    def test_sentence_chunker_fallback_uses_new_api_for_character(self):
        """Fallback is itself version-resilient: on chonkie >=1.4.0 the
        ``character`` fallback must use the new ``tokenizer=`` kwarg.

        Regression: a previous version unconditionally called
        ``ChonkieSentenceChunker(tokenizer_or_token_counter="character", ...)``
        in the fallback path, which raises ``TypeError`` on chonkie
        >=1.4.0 because the keyword was removed.
        """

        def side_effect(*args, **kwargs):
            # Simulate chonkie >=1.4.0: legacy keyword is gone.
            if "tokenizer_or_token_counter" in kwargs:
                raise TypeError("unexpected keyword argument 'tokenizer_or_token_counter'")
            value = kwargs.get("tokenizer")
            if value == "character":
                return MagicMock()
            raise ValueError(f"Tokenizer not found: {value}")

        with patch("chonkie.SentenceChunker", side_effect=side_effect) as mock_cls:
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

        self.assertIsNotNone(chunker.chunker)
        # Last attempt must be the new-API ``tokenizer="character"`` call.
        last_kwargs = mock_cls.call_args.kwargs
        self.assertEqual(last_kwargs.get("tokenizer"), "character")
        self.assertNotIn("tokenizer_or_token_counter", last_kwargs)

    def test_sentence_chunker_raises_when_fallback_also_fails(self):
        """If chonkie rejects every attempt — including the ``character``
        fallback — a clear ``RuntimeError`` chained to the original
        tokenizer-load error is raised instead of an opaque chonkie
        exception leaking out.
        """

        original_error = ValueError("Tokenizer not found: gpt2")

        def side_effect(*args, **kwargs):
            # Re-raise the same class but vary the message so we can
            # distinguish the original vs. fallback failure.
            if kwargs.get("tokenizer") == "character" or kwargs.get(
                "tokenizer_or_token_counter"
            ) == "character":
                raise ValueError("character also unavailable")
            raise original_error

        with patch("chonkie.SentenceChunker", side_effect=side_effect):
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
            with self.assertRaises(RuntimeError) as ctx:
                ChunkerFactory.from_config(config)

        self.assertIn("character", str(ctx.exception))
        # The original tokenizer-load error is preserved via __cause__.
        self.assertIsInstance(ctx.exception.__cause__, ValueError)
        self.assertIn("gpt2", str(ctx.exception.__cause__))
