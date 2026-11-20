"""Tests for UniversalAPIEmbedder."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import pytest

from openai import APITimeoutError, BadRequestError

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


def _mock_embedding_response(vectors_per_text=1, dims=2):
    """Build a MagicMock that mimics openai's embeddings response."""
    response = MagicMock()
    response.data = [
        MagicMock(embedding=[0.1 * (dimension + 1) for dimension in range(dims)])
        for _ in range(vectors_per_text)
    ]
    return response


def _bad_request_error(
    message: str, *, param: str | None = None, code: str | None = None
) -> BadRequestError:
    request = httpx.Request("POST", "https://api.example.com/v1/embeddings")
    response = httpx.Response(400, request=request)
    details = {"message": message}
    if param is not None:
        details["param"] = param
    if code is not None:
        details["code"] = code
    return BadRequestError(message, response=response, body={"error": details})


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

    def test_api_config_maps_embedding_dimension(self, monkeypatch):
        from memos.api.config import APIConfig

        monkeypatch.setenv("MOS_EMBEDDER_BACKEND", "universal_api")
        monkeypatch.setenv("EMBEDDING_DIMENSION", "1536")

        config = APIConfig.get_embedder_config()

        assert config["config"]["embedding_dims"] == 1536

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_passes_embedding_dims_to_api(self, mock_openai_client):
        response = _mock_embedding_response(vectors_per_text=1, dims=2)
        mock_create = MagicMock(return_value=response)
        mock_openai_client.return_value.embeddings.create = mock_create

        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)
        result = embedder.embed(["hello"])

        _, kwargs = mock_create.call_args
        assert kwargs.get("dimensions") == 256
        assert kwargs.get("timeout") == 5
        assert result == [[0.1, 0.2]]

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_without_dims_does_not_pass_dimensions(self, mock_openai_client):
        response = _mock_embedding_response(vectors_per_text=1, dims=2)
        mock_create = MagicMock(return_value=response)
        mock_openai_client.return_value.embeddings.create = mock_create

        config = _make_config(embedding_dims=None)
        embedder = UniversalAPIEmbedder(config)
        result = embedder.embed(["hello"])

        _, kwargs = mock_create.call_args
        assert "dimensions" not in kwargs
        assert kwargs.get("timeout") == 5
        assert result == [[0.1, 0.2]]

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_with_backup_client(self, mock_openai_client):
        primary_client = MagicMock()
        primary_client.embeddings.create = MagicMock(side_effect=ValueError("down"))
        backup_response = _mock_embedding_response(vectors_per_text=1, dims=2)
        backup_create = MagicMock(return_value=backup_response)
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
        assert primary_client.embeddings.create.call_count == 1
        assert backup_create.call_count == 1

    @patch("memos.embedders.universal_api.OpenAIClient")
    def test_embed_raises_when_no_backup(self, mock_openai_client):
        primary_client = MagicMock()
        primary_client.embeddings.create = MagicMock(side_effect=ValueError("primary failed"))
        mock_openai_client.return_value = primary_client

        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)
        with pytest.raises(ValueError, match="Embeddings request ended with error"):
            embedder.embed(["hello"])


class TestUniversalAPIEmbedderFallback:
    def test_call_embeddings_api_falls_back_when_dimensions_not_supported(self):
        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)

        ok_response = SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2])])
        mock_create = MagicMock(
            side_effect=[
                _bad_request_error("dimensions is not supported by this model"),
                ok_response,
            ]
        )
        mock_client = SimpleNamespace(embeddings=SimpleNamespace(create=mock_create))

        result = embedder._call_embeddings_api(mock_client, "text-embedding-3-large", ["hello"], 5)

        assert mock_create.call_count == 2
        assert mock_create.call_args_list[0].kwargs["dimensions"] == 256
        assert "dimensions" not in mock_create.call_args_list[1].kwargs
        assert all(call.kwargs["timeout"] == 5 for call in mock_create.call_args_list)
        assert result == [[0.1, 0.2]]

    def test_call_embeddings_api_falls_back_on_structured_dimensions_error(self):
        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)
        ok_response = SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2])])
        mock_create = MagicMock(
            side_effect=[
                _bad_request_error(
                    "Bad request",
                    param="dimensions",
                    code="unsupported_parameter",
                ),
                ok_response,
            ]
        )
        mock_client = SimpleNamespace(embeddings=SimpleNamespace(create=mock_create))

        result = embedder._call_embeddings_api(mock_client, "text-embedding-3-large", ["hello"], 5)

        assert mock_create.call_count == 2
        assert "dimensions" not in mock_create.call_args_list[1].kwargs
        assert result == [[0.1, 0.2]]

    def test_call_embeddings_api_does_not_fallback_on_timeout(self):
        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)
        request = httpx.Request("POST", "https://api.example.com/v1/embeddings")
        mock_create = MagicMock(side_effect=APITimeoutError(request=request))
        mock_client = SimpleNamespace(embeddings=SimpleNamespace(create=mock_create))

        with pytest.raises(APITimeoutError):
            embedder._call_embeddings_api(mock_client, "text-embedding-3-large", ["hello"], 5)

        assert mock_create.call_count == 1

    def test_call_embeddings_api_does_not_fallback_on_unrelated_bad_request(self):
        config = _make_config(embedding_dims=256)
        embedder = UniversalAPIEmbedder(config)
        mock_create = MagicMock(side_effect=_bad_request_error("input must not be empty"))
        mock_client = SimpleNamespace(embeddings=SimpleNamespace(create=mock_create))

        with pytest.raises(BadRequestError, match="input must not be empty"):
            embedder._call_embeddings_api(mock_client, "text-embedding-3-large", ["hello"], 5)

        assert mock_create.call_count == 1

    def test_call_embeddings_api_does_not_fallback_on_invalid_dimensions(self):
        config = _make_config(embedding_dims=0)
        embedder = UniversalAPIEmbedder(config)
        mock_create = MagicMock(
            side_effect=_bad_request_error(
                "dimensions must be greater than zero",
                param="dimensions",
                code="invalid_value",
            )
        )
        mock_client = SimpleNamespace(embeddings=SimpleNamespace(create=mock_create))

        with pytest.raises(BadRequestError, match="dimensions must be greater than zero"):
            embedder._call_embeddings_api(mock_client, "text-embedding-3-large", ["hello"], 5)

        assert mock_create.call_count == 1

    def test_call_embeddings_api_no_fallback_when_dims_not_set(self):
        config = _make_config(embedding_dims=None)
        embedder = UniversalAPIEmbedder(config)

        ok_response = SimpleNamespace(data=[SimpleNamespace(embedding=[0.1])])
        mock_create = MagicMock(return_value=ok_response)
        mock_client = SimpleNamespace(embeddings=SimpleNamespace(create=mock_create))

        result = embedder._call_embeddings_api(mock_client, "text-embedding-3-large", ["hello"], 5)

        assert "dimensions" not in mock_create.call_args.kwargs
        assert mock_create.call_args.kwargs["timeout"] == 5
        assert result == [[0.1]]
