from types import SimpleNamespace
from unittest.mock import patch

import pytest

from memos.embedders.base import BaseEmbedder, log_embedding_call
from tests.utils import check_module_base_class


def test_base_embedder_class():
    check_module_base_class(BaseEmbedder)


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
