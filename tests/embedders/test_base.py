from types import SimpleNamespace
from unittest.mock import patch

import pytest

from memos.configs.embedder import BaseEmbedderConfig
from memos.embedders.base import (
    _SAFE_EMBEDDING_MAX_TOKENS,
    BaseEmbedder,
    _count_tokens_for_embedding,
    _truncate_text_to_tokens,
    log_embedding_call,
)
from tests.utils import check_module_base_class


def test_base_embedder_class():
    check_module_base_class(BaseEmbedder)


class _ConcreteEmbedder(BaseEmbedder):
    def __init__(self, config):
        super().__init__(config)

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.0] for _ in texts]


class TestEffectiveMaxTokensDefaults:
    def test_none_max_tokens_falls_back_to_safe_default(self):
        config = BaseEmbedderConfig(
            model_name_or_path="text-embedding-3-large",
            max_tokens=None,
        )
        emb = _ConcreteEmbedder(config)
        assert emb._effective_max_tokens() == _SAFE_EMBEDDING_MAX_TOKENS
        assert _SAFE_EMBEDDING_MAX_TOKENS == 3072

    def test_zero_max_tokens_falls_back_to_safe_default(self):
        config = BaseEmbedderConfig(
            model_name_or_path="text-embedding-3-large",
            max_tokens=0,
        )
        emb = _ConcreteEmbedder(config)
        assert emb._effective_max_tokens() == _SAFE_EMBEDDING_MAX_TOKENS

    def test_explicit_max_tokens_honoured(self):
        config = BaseEmbedderConfig(
            model_name_or_path="text-embedding-3-large",
            max_tokens=1024,
        )
        emb = _ConcreteEmbedder(config)
        assert emb._effective_max_tokens() == 1024


class TestTruncateTextToTokens:
    def test_short_text_returned_unchanged(self):
        text = "short text"
        assert _truncate_text_to_tokens(text, 1000) == text

    def test_empty_and_none_inputs(self):
        assert _truncate_text_to_tokens("", 10) == ""
        assert _truncate_text_to_tokens("any", 0) == "any"
        assert _truncate_text_to_tokens("any", None) == "any"

    def test_long_cjk_text_truncates_within_budget(self):
        text = "记忆内容测试" * 1000  # ~6000 chars -> ~6000 tokens with simple heuristic
        limit = 500
        truncated = _truncate_text_to_tokens(text, limit)
        assert _count_tokens_for_embedding(truncated) <= limit
        assert len(truncated) >= limit


class TestTruncateTextsDefault3072:
    def test_short_texts_untouched(self):
        config = BaseEmbedderConfig(
            model_name_or_path="text-embedding-3-large",
            max_tokens=None,
        )
        emb = _ConcreteEmbedder(config)
        texts = ["a", "bb", "ccc"]
        assert emb._truncate_texts(texts) == texts

    def test_very_long_text_is_truncated_to_3072_tokens(self):
        config = BaseEmbedderConfig(
            model_name_or_path="text-embedding-3-large",
            max_tokens=None,
        )
        emb = _ConcreteEmbedder(config)
        long_text = "记忆内容长文本token" * 2000  # should clearly exceed 3072 tokens
        result = emb._truncate_texts([long_text, "short"])
        assert len(result) == 2
        assert result[1] == "short"
        assert _count_tokens_for_embedding(result[0]) <= 3072
        assert result[0] != long_text

    def test_explicit_override_disables_default(self):
        config = BaseEmbedderConfig(
            model_name_or_path="text-embedding-3-large",
            max_tokens=10,
        )
        emb = _ConcreteEmbedder(config)
        result = emb._truncate_texts(["a" * 1000])
        assert _count_tokens_for_embedding(result[0]) <= 10


def test_log_embedding_call_records_safe_structured_summary():
    class StubEmbedder:
        config = SimpleNamespace(model_name_or_path="embedding-model")

        @log_embedding_call
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.1, 0.2] for _ in texts]

    private_texts = ["private first text", "private second text"]
    with patch("memos.embedders.base.logger") as mock_logger:
        result = StubEmbedder().embed(private_texts)

    assert result == [[0.1, 0.2], [0.1, 0.2]]
    log_args = mock_logger.info.call_args.args
    rendered = log_args[0] % log_args[1:]
    assert "model=embedding-model" in rendered
    assert "batch_size=2" in rendered
    assert "total_chars=37" in rendered
    assert "max_chars=19" in rendered
    assert "text_hash=" in rendered
    assert "elapsed_ms=" in rendered
    assert "status=success" in rendered
    assert "private first text" not in rendered
    assert "private second text" not in rendered
    assert "0.1" not in rendered


def test_log_embedding_call_records_error_type_without_exception_content():
    class FailingEmbedder:
        config = SimpleNamespace(model_name_or_path="embedding-model")

        @log_embedding_call
        def embed(self, texts: list[str]) -> list[list[float]]:
            raise ValueError(f"failed to embed {texts}")

    with (
        patch("memos.embedders.base.logger") as mock_logger,
        pytest.raises(ValueError, match="private failing text"),
    ):
        FailingEmbedder().embed(["private failing text"])

    log_args = mock_logger.info.call_args.args
    rendered = log_args[0] % log_args[1:]
    assert "status=failed" in rendered
    assert "error_type=ValueError" in rendered
    assert "private failing text" not in rendered


def test_log_embedding_call_records_backup_model_without_text_content():
    class StubEmbedder:
        config = SimpleNamespace(
            model_name_or_path="primary-model",
            backup_model_name_or_path="backup-model",
        )
        use_backup_client = True

        @log_embedding_call
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.1] for _ in texts]

    with patch("memos.embedders.base.logger") as mock_logger:
        StubEmbedder().embed(["private input"])

    log_args = mock_logger.info.call_args.args
    rendered = log_args[0] % log_args[1:]
    assert "model=primary-model" in rendered
    assert "backup_model=backup-model" in rendered
    assert "backup_enabled=True" in rendered
    assert "private input" not in rendered
