from memos.api.config import APIConfig


def test_task_qwen_model_uses_qwen_provider_env(monkeypatch):
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_MODEL", "qwen3.6-flash")
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_API_BASE", "https://dashscope.example/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://openai.example/v1")

    config = APIConfig.get_preference_extractor_llm_config()

    assert config["backend"] == "qwen"
    assert config["config"]["model_name_or_path"] == "qwen3.6-flash"
    assert config["config"]["api_key"] == "qwen-key"
    assert config["config"]["api_base"] == "https://dashscope.example/v1"
    assert config["config"]["extra_body"] == {"enable_thinking": False}


def test_task_openai_model_uses_openai_provider_env(monkeypatch):
    monkeypatch.setenv("IMAGE_PARSER_MODEL", "gpt-4.1-mini")
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_API_BASE", "https://dashscope.example/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://openai.example/v1")

    config = APIConfig.get_image_parser_llm_config()

    assert config["backend"] == "openai"
    assert config["config"]["model_name_or_path"] == "gpt-4.1-mini"
    assert config["config"]["api_key"] == "openai-key"
    assert config["config"]["api_base"] == "https://openai.example/v1"


def test_document_parser_model_uses_provider_env_and_dedicated_temperature(monkeypatch):
    monkeypatch.setenv("DOCUMENT_PARSER_MODEL", "qwen3.6-flash")
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_API_BASE", "https://dashscope.example/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://openai.example/v1")

    config = APIConfig.get_document_parser_llm_config()

    assert config["backend"] == "qwen"
    assert config["config"]["model_name_or_path"] == "qwen3.6-flash"
    assert config["config"]["api_key"] == "qwen-key"
    assert config["config"]["api_base"] == "https://dashscope.example/v1"
    assert config["config"]["temperature"] == 0.8
    assert config["config"]["extra_body"] == {"enable_thinking": False}


def test_document_parser_model_falls_back_to_general_model(monkeypatch):
    monkeypatch.delenv("DOCUMENT_PARSER_MODEL", raising=False)
    monkeypatch.setenv("MEMREADER_GENERAL_MODEL", "gpt-4.1-mini")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://openai.example/v1")

    config = APIConfig.get_document_parser_llm_config()

    assert config["backend"] == "openai"
    assert config["config"]["model_name_or_path"] == "gpt-4.1-mini"
    assert config["config"]["temperature"] == 0.8


def test_document_parser_model_does_not_fall_back_to_main_memreader(monkeypatch):
    monkeypatch.delenv("DOCUMENT_PARSER_MODEL", raising=False)
    monkeypatch.delenv("MEMREADER_GENERAL_MODEL", raising=False)
    monkeypatch.setenv("MEMRADER_MODEL", "qwen3-0.6B")

    assert APIConfig.get_document_parser_llm_config() is None


def test_product_config_wires_document_parser_model(monkeypatch):
    monkeypatch.setenv("DOCUMENT_PARSER_MODEL", "gpt-4.1-mini")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://openai.example/v1")

    reader_config = APIConfig.get_product_default_config()["mem_reader"]["config"]

    document_config = reader_config["document_parser_llm"]
    assert document_config["backend"] == "openai"
    assert document_config["config"]["model_name_or_path"] == "gpt-4.1-mini"
    assert document_config["config"]["temperature"] == 0.8


def test_qwen_llm_only_uses_model_and_provider_endpoint_env(monkeypatch):
    monkeypatch.setenv("QWEN_MODEL", "qwen-flash")
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_API_BASE", "https://dashscope.example/v1")
    monkeypatch.setenv("QWEN_TEMPERATURE", "1.9")
    monkeypatch.setenv("QWEN_MAX_TOKENS", "123")
    monkeypatch.setenv("QWEN_TOP_P", "0.1")
    monkeypatch.setenv("QWEN_TOP_K", "3")
    monkeypatch.setenv("QWEN_REMOVE_THINK_PREFIX", "false")

    config = APIConfig.get_qwen_llm_config()

    assert config["backend"] == "qwen"
    assert config["config"]["model_name_or_path"] == "qwen-flash"
    assert config["config"]["api_key"] == "qwen-key"
    assert config["config"]["api_base"] == "https://dashscope.example/v1"
    assert config["config"]["temperature"] == 0.8
    assert config["config"]["max_tokens"] == 8000
    assert config["config"]["top_p"] == 0.9
    assert config["config"]["top_k"] == 50
    assert config["config"]["remove_think_prefix"] is True


def test_feedback_model_ignores_task_scoped_endpoint_env(monkeypatch):
    monkeypatch.setenv("FEEDBACK_MODEL", "qwen3.6-flash")
    monkeypatch.setenv("FEEDBACK_API_KEY", "legacy-feedback-key")
    monkeypatch.setenv("FEEDBACK_API_BASE", "https://legacy-feedback.example/v1")
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_API_BASE", "https://dashscope.example/v1")

    config = APIConfig.get_feedback_llm_config()

    assert config["backend"] == "qwen"
    assert config["config"]["api_key"] == "qwen-key"
    assert config["config"]["api_base"] == "https://dashscope.example/v1"


def test_memreader_general_model_only_needs_model_name_and_provider_env(monkeypatch):
    monkeypatch.setenv("MEMREADER_GENERAL_MODEL", "qwen-flash")
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_API_BASE", "https://dashscope.example/v1")
    monkeypatch.delenv("MEMREADER_GENERAL_API_KEY", raising=False)
    monkeypatch.delenv("MEMREADER_GENERAL_API_BASE", raising=False)

    config = APIConfig.get_memreader_general_llm_config()

    assert config["backend"] == "qwen"
    assert config["config"]["model_name_or_path"] == "qwen-flash"
    assert config["config"]["api_key"] == "qwen-key"
    assert config["config"]["api_base"] == "https://dashscope.example/v1"


def test_memreader_backup_uses_provider_env_for_general_model(monkeypatch):
    monkeypatch.setenv("MEMREADER_ENABLE_BACKUP", "true")
    monkeypatch.setenv("MEMREADER_GENERAL_MODEL", "gpt-4.1-mini")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://openai.example/v1")
    monkeypatch.setenv("MEMREADER_GENERAL_API_KEY", "legacy-general-key")
    monkeypatch.setenv("MEMREADER_GENERAL_API_BASE", "https://legacy-general.example/v1")

    config = APIConfig.get_memreader_config()

    assert config["config"]["backup_client"] is True
    assert config["config"]["backup_model_name_or_path"] == "gpt-4.1-mini"
    assert config["config"]["backup_api_key"] == "openai-key"
    assert config["config"]["backup_api_base"] == "https://openai.example/v1"
