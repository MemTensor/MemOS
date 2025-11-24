from memos.configs.llm import (
    BaseLLMConfig,
    HFLLMConfig,
    LLMConfigFactory,
    OllamaLLMConfig,
    OpenAILLMConfig,
)
from tests.utils import (
    check_config_base_class,
    check_config_factory_class,
    check_config_instantiation_invalid,
    check_config_instantiation_valid,
)


def test_base_llm_config():
    check_config_base_class(
        BaseLLMConfig,
        required_fields=[
            "model_name_or_path",
        ],
        optional_fields=[
            "temperature",
            "max_tokens",
            "top_p",
            "top_k",
            "remove_think_prefix",
            "default_headers",
        ],
    )

    check_config_instantiation_valid(
        BaseLLMConfig,
        {
            "model_name_or_path": "test-model",
            "temperature": 0.7,
            "max_tokens": 1024,
            "top_p": 0.9,
            "top_k": 50,
        },
    )

    check_config_instantiation_invalid(BaseLLMConfig)


def test_openai_llm_config():
    check_config_base_class(
        OpenAILLMConfig,
        required_fields=["model_name_or_path", "api_key"],
        optional_fields=[
            "temperature",
            "max_tokens",
            "top_p",
            "top_k",
            "api_base",
            "remove_think_prefix",
            "extra_body",
            "default_headers",
        ],
    )

    check_config_instantiation_valid(
        OpenAILLMConfig,
        {
            "model_name_or_path": "test-model",
            "api_key": "test-key",
            "api_base": "http://localhost:11434",
            "temperature": 0.7,
            "max_tokens": 1024,
            "top_p": 0.9,
        },
    )

    check_config_instantiation_invalid(OpenAILLMConfig)


def test_ollama_llm_config():
    check_config_base_class(
        OllamaLLMConfig,
        required_fields=[
            "model_name_or_path",
        ],
        optional_fields=[
            "temperature",
            "max_tokens",
            "top_p",
            "top_k",
            "remove_think_prefix",
            "api_base",
            "default_headers",
            "enable_thinking",
        ],
    )

    check_config_instantiation_valid(
        OllamaLLMConfig,
        {
            "model_name_or_path": "test-model",
            "temperature": 0.7,
            "max_tokens": 1024,
            "top_p": 0.9,
            "top_k": 50,
            "api_base": "http://localhost:11434",
        },
    )

    check_config_instantiation_invalid(OllamaLLMConfig)


def test_hf_llm_config():
    check_config_base_class(
        HFLLMConfig,
        required_fields=[
            "model_name_or_path",
        ],
        optional_fields=[
            "temperature",
            "max_tokens",
            "top_p",
            "top_k",
            "do_sample",
            "remove_think_prefix",
            "add_generation_prompt",
            "default_headers",
        ],
    )

    check_config_instantiation_valid(
        HFLLMConfig,
        {
            "model_name_or_path": "test-model",
            "temperature": 0.7,
            "max_tokens": 1024,
            "top_p": 0.9,
            "top_k": 50,
            "add_generation_prompt": True,
        },
    )

    check_config_instantiation_invalid(HFLLMConfig)


def test_llm_config_factory():
    check_config_factory_class(
        LLMConfigFactory,
        expected_backends=["openai", "ollama", "huggingface"],
    )

    check_config_instantiation_valid(
        LLMConfigFactory,
        {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "test-model",
                "temperature": 0.7,
                "max_tokens": 1024,
                "top_p": 0.9,
                "top_k": 50,
            },
        },
    )

    check_config_instantiation_invalid(LLMConfigFactory)
