from unittest.mock import MagicMock, patch

import pytest

from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS


@pytest.fixture
def simple_config():
    """Simple configuration for testing"""
    return MOSConfig(
        user_id="test_user",
        session_id="test_session",
        chat_model={
            "backend": "huggingface",
            "config": {
                "model_name_or_path": "test-model",
                "temperature": 0.1,
                "max_tokens": 100,
            },
        },
        mem_reader={
            "backend": "simple_struct",
            "config": {
                "llm": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "test-model",
                        "temperature": 0.8,
                        "max_tokens": 100,
                    },
                },
                "embedder": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "test-embed",
                    },
                },
                "chunker": {
                    "backend": "sentence",
                    "config": {
                        "tokenizer_or_token_counter": "gpt2",
                        "chunk_size": 512,
                        "chunk_overlap": 128,
                        "min_sentences_per_chunk": 1,
                    },
                },
            },
        },
        enable_textual_memory=True,
        enable_activation_memory=False,
        enable_parametric_memory=False,
        top_k=5,
        max_turns_window=10,
    )


@patch("memos.mem_os.core.UserManager")
@patch("memos.mem_os.core.MemReaderFactory")
@patch("memos.mem_os.core.LLMFactory")
def test_mos_can_initialize(mock_llm, mock_reader, mock_user_manager, simple_config):
    """Test that MOS can be initialized successfully"""
    # Mock all dependencies
    mock_llm.from_config.return_value = MagicMock()
    mock_reader.from_config.return_value = MagicMock()

    user_manager_instance = MagicMock()
    user_manager_instance.validate_user.return_value = True
    mock_user_manager.return_value = user_manager_instance

    # Create MOS instance
    mos = MOS(simple_config)

    # Basic assertions
    assert mos is not None
    assert mos.user_id == "test_user"


@patch("memos.mem_os.core.UserManager")
@patch("memos.mem_os.core.MemReaderFactory")
@patch("memos.mem_os.core.LLMFactory")
def test_mos_has_core_methods(mock_llm, mock_reader, mock_user_manager, simple_config):
    """Test that MOS inherits methods from MOSCore"""
    # Mock all dependencies
    mock_llm.from_config.return_value = MagicMock()
    mock_reader.from_config.return_value = MagicMock()

    user_manager_instance = MagicMock()
    user_manager_instance.validate_user.return_value = True
    mock_user_manager.return_value = user_manager_instance

    # Create MOS instance
    mos = MOS(simple_config)

    # Check that key methods exist and are callable
    assert hasattr(mos, "chat")
    assert hasattr(mos, "search")
    assert hasattr(mos, "add")
    assert callable(mos.chat)
    assert callable(mos.search)
    assert callable(mos.add)


@patch("memos.mem_os.core.UserManager")
@patch("memos.mem_os.core.MemReaderFactory")
@patch("memos.mem_os.core.LLMFactory")
@patch("memos.mem_os.main.MOSCore.chat")
def test_mos_chat_with_custom_prompt_no_cot(
    mock_core_chat, mock_llm, mock_reader, mock_user_manager, simple_config
):
    """Test that MOS.chat passes base_prompt to MOSCore.chat when CoT is disabled."""
    # Mock all dependencies
    mock_llm.from_config.return_value = MagicMock()
    mock_reader.from_config.return_value = MagicMock()
    user_manager_instance = MagicMock()
    user_manager_instance.validate_user.return_value = True
    mock_user_manager.return_value = user_manager_instance

    # Disable CoT
    simple_config.PRO_MODE = False
    mos = MOS(simple_config)

    # Call chat with a custom prompt
    custom_prompt = "You are a helpful bot."
    mos.chat("Hello", user_id="test_user", base_prompt=custom_prompt)

    # Assert that the core chat method was called with the custom prompt
    mock_core_chat.assert_called_once_with("Hello", "test_user", base_prompt=custom_prompt)


@patch("memos.mem_os.core.UserManager")
@patch("memos.mem_os.core.MemReaderFactory")
@patch("memos.mem_os.core.LLMFactory")
@patch("memos.mem_os.main.MOS._generate_enhanced_response_with_context")
@patch("memos.mem_os.main.MOS.cot_decompose")
@patch("memos.mem_os.main.MOS.get_sub_answers")
def test_mos_chat_with_custom_prompt_with_cot(
    mock_get_sub_answers,
    mock_cot_decompose,
    mock_generate_enhanced_response,
    mock_llm,
    mock_reader,
    mock_user_manager,
    simple_config,
):
    """Test that MOS.chat passes base_prompt correctly when CoT is enabled."""
    # Mock dependencies
    mock_llm.from_config.return_value = MagicMock()
    mock_reader.from_config.return_value = MagicMock()
    user_manager_instance = MagicMock()
    user_manager_instance.validate_user.return_value = True
    user_manager_instance.get_user_cubes.return_value = [MagicMock(cube_id="test_cube")]
    mock_user_manager.return_value = user_manager_instance

    # Mock CoT process
    mock_cot_decompose.return_value = {"is_complex": True, "sub_questions": ["Sub-question 1"]}
    mock_get_sub_answers.return_value = (["Sub-question 1"], ["Sub-answer 1"])

    # Enable CoT
    simple_config.PRO_MODE = True
    mos = MOS(simple_config)

    # Mock the search engine to avoid errors
    mos.mem_cubes["test_cube"] = MagicMock()
    mos.mem_cubes["test_cube"].text_mem = MagicMock()

    # Call chat with a custom prompt
    custom_prompt = "You are a super helpful bot. Context: {memories}"
    mos.chat("Complex question", user_id="test_user", base_prompt=custom_prompt)

    # Assert that the enhanced response generator was called with the prompt
    mock_generate_enhanced_response.assert_called_once()
    call_args = mock_generate_enhanced_response.call_args[1]
    assert call_args.get("base_prompt") == custom_prompt
