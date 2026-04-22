import unittest

from unittest.mock import MagicMock, patch

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.embedders.universal_api import UniversalAPIEmbedder


class TestUniversalAPIEmbedder(unittest.TestCase):
    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_single_text(self, mock_openai_client):
        """Test embedding a single text with OpenAI provider."""
        # Mock the embeddings.create return value
        mock_response = MagicMock()
        mock_response.data = [MagicMock(embedding=[0.1, 0.2, 0.3, 0.4])]
        mock_openai_client.return_value.embeddings.create.return_value = mock_response

        config = UniversalAPIEmbedderConfig(
            provider="openai",
            api_key="fake-api-key",
            base_url="https://api.openai.com/v1",
            model_name_or_path="text-embedding-3-large",
        )

        embedder = UniversalAPIEmbedder(config)
        text = ["Test input for embedding."]
        result = embedder.embed(text)

        # Assert OpenAIClient was created with proper args
        mock_openai_client.assert_called_once_with(
            api_key="fake-api-key", base_url="https://api.openai.com/v1", default_headers=None
        )

        # Assert embeddings.create called with correct params
        embedder.client.embeddings.create.assert_called_once_with(
            model="text-embedding-3-large",
            input=text,
        )

        self.assertEqual(len(result[0]), 4)

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_batch_text(self, mock_openai_client):
        """Test embedding multiple texts at once with OpenAI provider."""
        # Mock response for multiple texts
        mock_response = MagicMock()
        mock_response.data = [
            MagicMock(embedding=[0.1, 0.2]),
            MagicMock(embedding=[0.3, 0.4]),
            MagicMock(embedding=[0.5, 0.6]),
        ]
        mock_openai_client.return_value.embeddings.create.return_value = mock_response

        config = UniversalAPIEmbedderConfig(
            provider="openai",
            api_key="fake-api-key",
            base_url="https://api.openai.com/v1",
            model_name_or_path="text-embedding-3-large",
        )

        embedder = UniversalAPIEmbedder(config)
        texts = ["First text.", "Second text.", "Third text."]
        result = embedder.embed(texts)

        embedder.client.embeddings.create.assert_called_once_with(
            model="text-embedding-3-large",
            input=texts,
        )

        self.assertEqual(len(result), 3)
        self.assertEqual(result[0], [0.1, 0.2])


if __name__ == "__main__":
    unittest.main()
