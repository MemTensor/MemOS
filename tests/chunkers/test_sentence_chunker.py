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
            self.assertEqual(chunks[0].text, "This is the first sentence.")
            self.assertEqual(chunks[0].token_count, 6)
            self.assertEqual(chunks[0].sentences, ["This is the first sentence."])
