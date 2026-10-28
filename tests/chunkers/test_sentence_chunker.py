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

    def test_sentence_chunker_preserves_urls_in_sentences(self):
        """Test that URLs are restored in both text and sentences fields."""
        with patch("chonkie.SentenceChunker") as mock_chunker_cls:
            # Set up the mock
            mock_chunker = MagicMock()
            url = "https://example.com/test"
            protected_text = f"Check out __URL_0__ for details."

            # Mock returns chunk with protected URL placeholder in sentences
            mock_chunk = MagicMock(
                text=protected_text,
                token_count=6,
                sentences=[protected_text],
            )
            mock_chunker.chunk.return_value = [mock_chunk]
            mock_chunker_cls.return_value = mock_chunker

            # Create chunker
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

            # Test with URL text
            text = f"Check out {url} for details."
            chunks = chunker.chunk(text)

            # Verify chunk count
            self.assertEqual(len(chunks), 1)

            # Handle both return types: list[str] | list[Chunk]
            if isinstance(chunks[0], str):
                # If returns list[str], URL should be restored in the string
                self.assertIn(url, chunks[0])
                self.assertNotIn("__URL_", chunks[0])
            else:
                # If returns list[Chunk], metadata must survive:
                # - URLs must be restored in text field
                # - URLs must be restored in sentences field (not just placeholder)
                # - token_count and sentences must be preserved
                from memos.chunkers.base import Chunk

                self.assertIsInstance(chunks[0], Chunk)
                self.assertIn(url, chunks[0].text)
                self.assertNotIn("__URL_", chunks[0].text)

                # The critical assertions from OCR finding:
                # sentences metadata must survive and URLs must be restored there too
                self.assertEqual(len(chunks[0].sentences), 1)
                self.assertIn(url, chunks[0].sentences[0])
                self.assertNotIn("__URL_", chunks[0].sentences[0])
