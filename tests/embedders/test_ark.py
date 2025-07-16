import unittest

from unittest.mock import patch

from memos.configs.embedder import EmbedderConfigFactory
from memos.embedders.factory import ArkEmbedder, EmbedderFactory


class TestEmbedderFactory(unittest.TestCase):
    @patch.object(ArkEmbedder, "embed")
    def test_embed_single_text(self, mock_embed):
        """Test embedding a single text."""
        mock_embed.return_value = [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6]]

        config = EmbedderConfigFactory.model_validate(
            {
                "backend": "ark",
                "config": {
                    "model_name_or_path": "doubao-embedding-vision-250615",
                    "embedding_dims": 2048,
                    "api_key": "your-api-key",
                    "api_base": "https://ark.cn-beijing.volces.com/api/v3",
                },
            }
        )
        embedder = EmbedderFactory.from_config(config)
        text = "This is a sample text for embedding generation."
        result = embedder.embed([text])

        mock_embed.assert_called_once_with([text])
        self.assertEqual(len(result[0]), 6)

    @patch.object(ArkEmbedder, "embed")
    def test_embed_batch_text(self, mock_embed):
        """Test embedding multiple texts at once."""
        mock_embed.return_value = [
            [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
            [0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
            [0.3, 0.4, 0.5, 0.6, 0.1, 0.2],
        ]

        config = EmbedderConfigFactory.model_validate(
            {
                "backend": "ark",
                "config": {
                    "model_name_or_path": "doubao-embedding-vision-250615",
                    "embedding_dims": 2048,
                    "api_key": "your-api-key",
                    "api_base": "https://ark.cn-beijing.volces.com/api/v3",
                },
            }
        )
        embedder = EmbedderFactory.from_config(config)
        texts = [
            "First sample text for batch embedding.",
            "Second sample text for batch embedding.",
            "Third sample text for batch embedding.",
        ]

        result = embedder.embed(texts)

        mock_embed.assert_called_once_with(texts)
        self.assertEqual(len(result), 3)
        self.assertEqual(len(result[0]), 6)
