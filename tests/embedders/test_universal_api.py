"""Tests for UniversalAPIEmbedder."""

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.embedders.universal_api import UniversalAPIEmbedder


def _make_config(**overrides):
    defaults = {
        "provider": "openai",
        "api_key": "test-key",
        "model_name_or_path": "text-embedding-3-large",
        "embedding_dims": None,
    }
    defaults.update(overrides)
    return UniversalAPIEmbedderConfig(**defaults)


class TestUniversalAPIEmbedderDimensions:
    def test_build_embedding_kwargs_no_dims(self):
        kwargs = UniversalAPIEmbedder._build_embedding_kwargs(
            "text-embedding-3-large", ["hello"], None
        )
        assert kwargs == {"model": "text-embedding-3-large", "input": ["hello"]}
        assert "dimensions" not in kwargs

    def test_build_embedding_kwargs_with_dims(self):
        kwargs = UniversalAPIEmbedder._build_embedding_kwargs(
            "text-embedding-3-large", ["hello"], 256
        )
        assert kwargs == {
            "model": "text-embedding-3-large",
            "input": ["hello"],
            "dimensions": 256,
        }

    def test_build_embedding_kwargs_zero_dims(self):
        kwargs = UniversalAPIEmbedder._build_embedding_kwargs(
            "text-embedding-3-large", ["hello"], 0
        )
        assert kwargs["dimensions"] == 0

    @patch.object(UniversalAPIEmbedder, "_call_embeddings_api")
    def test_embed_passes_embedding_dims_to_api(self, mock_call):
        mock_call.return_value = [[0.1, 0.2] for _ in ["hello"]]
        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)
        embedder.embed(["hello"])
        mock_call.assert_called_once()
        call_kwargs = mock_call.call_args[0]
        assert call_kwargs[2] == ["hello"]
        assert call_kwargs[1] == "text-embedding-3-large"

    @patch.object(UniversalAPIEmbedder, "_call_embeddings_api")
    def test_embed_without_dims_does_not_pass_dimensions(self, mock_call):
        mock_call.return_value = [[0.1, 0.2] for _ in ["hello"]]
        config = _make_config(embedding_dims=None)
        embedder = UniversalAPIEmbedder(config)
        embedder.embed(["hello"])
        mock_call.assert_called_once()

    @patch.object(UniversalAPIEmbedder, "_call_embeddings_api")
    def test_embed_with_backup_client(self, mock_call):
        mock_call.side_effect = [
            ValueError("primary failed"),
            [[0.1, 0.2] for _ in ["hello"]],
        ]
        config = _make_config(
            embedding_dims=256,
            backup_client=True,
            backup_api_key="backup-key",
            backup_base_url="https://api.example.com",
            backup_model_name_or_path="text-embedding-3-small",
        )
        embedder = UniversalAPIEmbedder(config)
        result = embedder.embed(["hello"])
        assert result == [[0.1, 0.2]]
        assert mock_call.call_count == 2

    @patch.object(UniversalAPIEmbedder, "_call_embeddings_api")
    def test_embed_raises_when_no_backup(self, mock_call):
        mock_call.side_effect = ValueError("primary failed")
        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)
        with pytest.raises(ValueError, match="Embeddings request ended with error"):
            embedder.embed(["hello"])


class TestUniversalAPIEmbedderFallback:
    def test_call_embeddings_api_falls_back_when_dimensions_not_supported(self):
        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)

        mock_client = SimpleNamespace()
        call_count = [0]

        def mock_create(**kwargs):
            call_count[0] += 1
            if kwargs.get("dimensions") is not None:
                raise Exception("dimensions not supported")
            return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2])])

        mock_client.embeddings = SimpleNamespace(create=mock_create)

        with patch("memos.embedders.universal_api.asyncio.run") as mock_run:
            mock_run.side_effect = lambda x: x  # pass-through
            result = embedder._call_embeddings_api(
                mock_client, "text-embedding-3-large", ["hello"], 5
            )

        assert call_count[0] == 2
        assert result == [[0.1, 0.2]]

    def test_call_embeddings_api_no_fallback_when_dims_not_set(self):
        config = _make_config(embedding_dims=None)
        embedder = UniversalAPIEmbedder(config)

        mock_client = SimpleNamespace()

        def mock_create(**kwargs):
            if kwargs.get("dimensions") is not None:
                raise AssertionError("dimensions should not be passed when embedding_dims is None")
            return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1])])

        mock_client.embeddings = SimpleNamespace(create=mock_create)

        with patch("memos.embedders.universal_api.asyncio.run") as mock_run:
            mock_run.side_effect = lambda x: x
            result = embedder._call_embeddings_api(
                mock_client, "text-embedding-3-large", ["hello"], 5
            )

        assert result == [[0.1]]
