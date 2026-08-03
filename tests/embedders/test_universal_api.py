"""Tests for UniversalAPIEmbedder."""

import asyncio

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.embedders.universal_api import UniversalAPIEmbedder


class _DimensionsUnsupportedError(Exception):
    """Raised by the mock backend when dimensions are rejected."""


def _make_config(**overrides):
    defaults = {
        "provider": "openai",
        "api_key": "test-key",
        "model_name_or_path": "text-embedding-3-large",
        "embedding_dims": None,
    }
    defaults.update(overrides)
    return UniversalAPIEmbedderConfig(**defaults)


def _mock_embedding_response(vectors_per_text=1, dims=2):
    """Build a MagicMock that mimics openai's embeddings response."""
    response = MagicMock()
    response.data = [MagicMock(embedding=[0.1 * (i + 1)] * dims) for i in range(vectors_per_text)]
    return response


def _awaitable_response(response):
    """Wrap a MagicMock response so it can be returned by AsyncMock.

    ``asyncio.wait_for`` awaits its coroutine argument, so the
    ``embeddings.create`` mock must be an async function (AsyncMock).
    """

    async def _call(**kwargs):
        return response

    return AsyncMock(side_effect=_call)


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

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_passes_embedding_dims_to_api(self, mock_openai_client):
        response = _mock_embedding_response(vectors_per_text=1, dims=2)
        mock_create = _awaitable_response(response)
        mock_openai_client.return_value.embeddings.create = mock_create

        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)
        embedder.embed(["hello"])

        _, kwargs = mock_create.call_args
        assert kwargs.get("dimensions") == 256

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_without_dims_does_not_pass_dimensions(self, mock_openai_client):
        response = _mock_embedding_response(vectors_per_text=1, dims=2)
        mock_create = _awaitable_response(response)
        mock_openai_client.return_value.embeddings.create = mock_create

        config = _make_config(embedding_dims=None)
        embedder = UniversalAPIEmbedder(config)
        embedder.embed(["hello"])

        _, kwargs = mock_create.call_args
        assert "dimensions" not in kwargs

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_with_backup_client(self, mock_openai_client):
        primary_client = MagicMock()
        primary_client.embeddings.create = AsyncMock(side_effect=ValueError("down"))
        backup_response = _mock_embedding_response(vectors_per_text=1, dims=2)
        backup_create = _awaitable_response(backup_response)
        backup_client = MagicMock()
        backup_client.embeddings.create = backup_create

        def client_factory(api_key, **kwargs):
            if api_key == "primary":
                return primary_client
            return backup_client

        mock_openai_client.side_effect = client_factory

        config = _make_config(
            api_key="primary",
            embedding_dims=256,
            backup_client=True,
            backup_api_key="backup-key",
            backup_base_url="https://api.example.com",
            backup_model_name_or_path="text-embedding-3-small",
        )
        embedder = UniversalAPIEmbedder(config)
        result = embedder.embed(["hello"])
        assert result == [[0.1, 0.2]]
        assert backup_create.await_count == 1

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_raises_when_no_backup(self, mock_openai_client):
        primary_client = MagicMock()
        primary_client.embeddings.create = AsyncMock(side_effect=ValueError("primary failed"))
        mock_openai_client.return_value = primary_client

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
        ok_response = SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2])])

        async def mock_create(**kwargs):
            call_count[0] += 1
            if kwargs.get("dimensions") is not None:
                raise _DimensionsUnsupportedError("dimensions not supported")
            return ok_response

        mock_client.embeddings = SimpleNamespace(create=mock_create)

        with patch.object(asyncio, "wait_for", side_effect=lambda coro, timeout: coro):
            result = embedder._call_embeddings_api(
                mock_client, "text-embedding-3-large", ["hello"], 5
            )

        assert call_count[0] == 2
        assert result == [[0.1, 0.2]]

    def test_call_embeddings_api_no_fallback_when_dims_not_set(self):
        config = _make_config(embedding_dims=None)
        embedder = UniversalAPIEmbedder(config)

        mock_client = SimpleNamespace()
        ok_response = SimpleNamespace(data=[SimpleNamespace(embedding=[0.1])])

        async def mock_create(**kwargs):
            if kwargs.get("dimensions") is not None:
                raise AssertionError("dimensions should not be passed when embedding_dims is None")
            return ok_response

        mock_client.embeddings = SimpleNamespace(create=mock_create)

        with patch.object(asyncio, "wait_for", side_effect=lambda coro, timeout: coro):
            result = embedder._call_embeddings_api(
                mock_client, "text-embedding-3-large", ["hello"], 5
            )

        assert result == [[0.1]]
