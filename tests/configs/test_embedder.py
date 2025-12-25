from memos.configs.embedder import (
    BaseEmbedderConfig,
    EmbedderConfigFactory,
    OllamaEmbedderConfig,
)
from tests.utils import (
    check_config_base_class,
    check_config_factory_class,
    check_config_instantiation_invalid,
    check_config_instantiation_valid,
)


def test_base_embedder_config():
    check_config_base_class(
        BaseEmbedderConfig,
        required_fields=[
            "model_name_or_path",
        ],
        optional_fields=["embedding_dims", "max_tokens", "headers_extra"],
    )

    check_config_instantiation_valid(
        BaseEmbedderConfig,
        {
            "model_name_or_path": "test-model",
        },
    )

    check_config_instantiation_invalid(BaseEmbedderConfig)


def test_ollama_embedder_config():
    check_config_base_class(
        OllamaEmbedderConfig,
        required_fields=[
            "model_name_or_path",
        ],
        optional_fields=["embedding_dims", "max_tokens", "headers_extra", "api_base"],
    )

    check_config_instantiation_valid(
        OllamaEmbedderConfig,
        {
            "model_name_or_path": "test-model",
            "api_base": "http://localhost:11434",
        },
    )

    check_config_instantiation_invalid(OllamaEmbedderConfig)


def test_embedder_config_factory():
    check_config_factory_class(
        EmbedderConfigFactory,
        expected_backends=["ollama"],
    )

    check_config_instantiation_valid(
        EmbedderConfigFactory,
        {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "test-model",
            },
        },
    )

    check_config_instantiation_invalid(EmbedderConfigFactory)
