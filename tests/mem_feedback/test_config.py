import pytest

from pydantic import ValidationError

from memos.configs.memory import MemFeedbackConfig, MemoryConfigFactory


def _llm_config() -> dict:
    return {
        "backend": "ollama",
        "config": {"model_name_or_path": "llama3"},
    }


def _embedder_config() -> dict:
    return {
        "backend": "ollama",
        "config": {
            "model_name_or_path": "nomic-embed-text",
            "embedding_dims": 768,
        },
    }


def _graph_db_config() -> dict:
    return {
        "backend": "polardb",
        "config": {
            "host": "localhost",
            "user": "postgres",
            "password": "postgres",
            "db_name": "memos_test",
        },
    }


def _mem_reader_config() -> dict:
    return {
        "backend": "simple_struct",
        "config": {
            "llm": _llm_config(),
            "embedder": _embedder_config(),
            "chunker": {"backend": "sentence", "config": {}},
        },
    }


def _feedback_config() -> dict:
    return {
        "extractor_llm": _llm_config(),
        "embedder": _embedder_config(),
        "graph_db": _graph_db_config(),
        "mem_reader": _mem_reader_config(),
    }


def test_mem_feedback_config_accepts_valid_local_config():
    config = MemFeedbackConfig.model_validate(_feedback_config())

    assert config.extractor_llm.backend == "ollama"
    assert config.embedder.backend == "ollama"
    assert config.graph_db.backend == "polardb"
    assert config.mem_reader.backend == "simple_struct"


def test_mem_feedback_config_defaults_optional_behavior_fields():
    config = MemFeedbackConfig.model_validate(_feedback_config())

    assert config.reorganize is False
    assert config.memory_size is None
    assert config.reranker is None


def test_memory_config_factory_registers_mem_feedback_backend():
    factory = MemoryConfigFactory(backend="mem_feedback", config=_feedback_config())

    assert isinstance(factory.config, MemFeedbackConfig)


def test_mem_feedback_config_rejects_extra_fields():
    invalid_config = {**_feedback_config(), "unknown_option": True}

    with pytest.raises(ValidationError):
        MemFeedbackConfig.model_validate(invalid_config)
