import warnings

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.core import MOSCore
from memos.mem_user.user_manager import UserRole
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata


warnings.filterwarnings("ignore", category=pytest.PytestConfigWarning)


@pytest.fixture
def mock_config():
    """Create a mock MOS config for testing."""
    return {
        "user_id": "test_user",
        "chat_model": {
            "backend": "huggingface",
            "config": {
                "model_name_or_path": "hf-internal-testing/tiny-random-gpt2",
                "temperature": 0.1,
                "remove_think_prefix": True,
                "max_tokens": 4096,
            },
        },
        "mem_reader": {
            "backend": "simple_struct",
            "config": {
                "llm": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "qwen3:0.6b",
                        "temperature": 0.8,
                        "max_tokens": 1024,
                        "top_p": 0.9,
                        "top_k": 50,
                    },
                },
                "embedder": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "nomic-embed-text:latest",
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
        "max_turns_window": 20,
        "top_k": 5,
        "enable_textual_memory": True,
        "enable_activation_memory": False,
        "enable_parametric_memory": False,
    }


@pytest.fixture
def mock_user_manager():
    """Create a mock user manager."""
    manager = MagicMock()
    manager.validate_user.return_value = True
    manager.get_user_cubes.return_value = [
        MagicMock(cube_id="test_cube_1"),
        MagicMock(cube_id="test_cube_2"),
    ]
    manager.validate_user_cube_access.return_value = True
    manager.create_user.return_value = "test_user"
    manager.list_users.return_value = [
        MagicMock(
            user_id="test_user",
            user_name="Test User",
            role=UserRole.USER,
            created_at=datetime.now(),
            is_active=True,
        )
    ]
    return manager


@pytest.fixture
def mock_mem_cube():
    """Create a mock memory cube."""
    cube = MagicMock()

    # Mock text memory
    text_mem = MagicMock()
    text_mem.search.return_value = [
        TextualMemoryItem(
            memory="I like playing football",
            metadata=TextualMemoryMetadata(
                user_id="test_user", session_id="test_session", source="conversation"
            ),
        )
    ]
    text_mem.get_all.return_value = [
        TextualMemoryItem(
            memory="Test memory content",
            metadata=TextualMemoryMetadata(
                user_id="test_user", session_id="test_session", source="conversation"
            ),
        )
    ]
    text_mem.get.return_value = TextualMemoryItem(
        memory="Specific memory",
        metadata=TextualMemoryMetadata(
            user_id="test_user", session_id="test_session", source="conversation"
        ),
    )

    cube.text_mem = text_mem
    cube.act_mem = None
    cube.para_mem = None

    # Mock config
    cube.config = MagicMock()
    cube.config.text_mem.backend = "general_text"

    return cube


@pytest.fixture
def mock_llm():
    """Create a mock LLM."""
    llm = MagicMock()
    llm.generate.return_value = "This is a test response from the assistant."
    return llm


@pytest.fixture
def mock_mem_reader():
    """Create a mock memory reader."""
    reader = MagicMock()
    reader.get_memory.return_value = [
        TextualMemoryItem(
            memory="Extracted memory from reader",
            metadata=TextualMemoryMetadata(
                user_id="test_user", session_id="test_session", source="conversation"
            ),
        )
    ]
    return reader


class TestMOSInitialization:
    """Test MOS initialization and basic setup."""

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_mos_init_success(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
    ):
        """Test successful MOS initialization."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        # Create MOS instance
        config = MOSConfig(**mock_config)
        mos = MOSCore(config)

        # Assertions
        assert mos.config == config
        assert mos.user_id == "test_user"
        # Test mem_cubes is empty (compatible with both dict and ThreadSafeDict)
        assert len(mos.mem_cubes) == 0
        assert not mos.mem_cubes  # Empty check that works for both types
        assert mos.chat_llm == mock_llm
        assert mos.mem_reader == mock_mem_reader
        mock_user_manager.validate_user.assert_called_once_with("test_user")

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.LLMFactory")
    def test_mos_init_invalid_user(self, mock_llm_factory, mock_user_manager_class, mock_config):
        """Test MOS initialization with invalid user."""
        mock_llm_factory.from_config.return_value = MagicMock()
        mock_user_manager = MagicMock()
        mock_user_manager.validate_user.return_value = False
        mock_user_manager_class.return_value = mock_user_manager

        config = MOSConfig(**mock_config)

        with pytest.raises(ValueError, match="User 'test_user' does not exist or is inactive"):
            MOSCore(config)


class TestMOSUserManagement:
    """Test MOS user management functions."""

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_create_user(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
    ):
        """Test user creation."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))

        result = mos.create_user("new_user", UserRole.USER, "New User")

        mock_user_manager.create_user.assert_called_once_with("New User", UserRole.USER, "new_user")
        assert result == "test_user"  # Return value from mock

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_list_users(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
    ):
        """Test listing users."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))

        users = mos.list_users()

        assert len(users) == 1
        assert users[0]["user_id"] == "test_user"
        assert users[0]["user_name"] == "Test User"
        assert users[0]["role"] == "USER"


class TestMOSMemoryOperations:
    """Test MOS memory operations."""

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_register_mem_cube(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test memory cube registration."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager
        mock_user_manager.get_cube.return_value = None  # Cube doesn't exist

        # Mock only the static method, not the entire class
        with patch.object(GeneralMemCube, "init_from_dir", return_value=mock_mem_cube):
            mos = MOSCore(MOSConfig(**mock_config))

            with patch("os.path.exists", return_value=True):
                mos.register_mem_cube("test_cube_path", "test_cube_1")

            assert "test_cube_1" in mos.mem_cubes
            GeneralMemCube.init_from_dir.assert_called_once_with("test_cube_path")

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_search_memories(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test memory search functionality."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))
        mos.mem_cubes["test_cube_1"] = mock_mem_cube

        result = mos.search("football")

        assert isinstance(result, dict)
        assert "text_mem" in result
        assert "act_mem" in result
        assert "para_mem" in result
        assert len(result["text_mem"]) == 1
        assert result["text_mem"][0]["cube_id"] == "test_cube_1"
        # Verify the search was called with the correct parameters
        mock_mem_cube.text_mem.search.assert_called_once()
        call_args = mock_mem_cube.text_mem.search.call_args
        assert call_args[0] == ("football",)  # positional args
        assert call_args[1]["top_k"] == 5
        assert call_args[1]["mode"] == "fast"
        assert call_args[1]["manual_close_internet"]
        assert "info" in call_args[1]
        assert call_args[1]["info"]["user_id"] == "test_user"
        assert "session_id" in call_args[1]["info"]

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    @patch("memos.mem_os.core.logger")
    def test_register_mem_cube_embedder_consistency_warning(
        self,
        mock_logger,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test embedder consistency warning when cube embedder differs from MOS config."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager
        mock_user_manager.get_cube.return_value = None  # Cube doesn't exist

        # Create different embedder configs for MOS and cube
        mos_embedder_config = {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "nomic-embed-text:latest",
            },
        }

        cube_embedder_config = {
            "backend": "sentence_transformer",
            "config": {
                "model_name_or_path": "all-MiniLM-L6-v2",
            },
        }

        # Mock the cube's text memory embedder config
        mock_mem_cube.text_mem.config.embedder = cube_embedder_config

        # Mock only the static method, not the entire class
        with patch.object(GeneralMemCube, "init_from_dir", return_value=mock_mem_cube):
            mos = MOSCore(MOSConfig(**mock_config))

            # Ensure MOS config has different embedder
            mos.config.mem_reader.config.embedder = mos_embedder_config

            with patch("os.path.exists", return_value=True):
                mos.register_mem_cube("test_cube_path", "test_cube_1")

            # Verify warning was logged
            mock_logger.warning.assert_called_with(
                f"Cube Embedder is not consistent with MOSConfig for cube: test_cube_1, will use Cube Embedder: {cube_embedder_config}"
            )

            # Verify cube was still registered
            assert "test_cube_1" in mos.mem_cubes
            GeneralMemCube.init_from_dir.assert_called_once_with("test_cube_path")

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    @patch("memos.mem_os.core.logger")
    def test_register_mem_cube_embedder_consistency_no_warning(
        self,
        mock_logger,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test no warning when cube embedder is consistent with MOS config."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager
        mock_user_manager.get_cube.return_value = None  # Cube doesn't exist

        # Create same embedder config for both MOS and cube
        embedder_config = {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "nomic-embed-text:latest",
            },
        }

        # Mock the cube's text memory embedder config to be the same
        mock_mem_cube.text_mem.config.embedder = embedder_config

        # Mock only the static method, not the entire class
        with patch.object(GeneralMemCube, "init_from_dir", return_value=mock_mem_cube):
            mos = MOSCore(MOSConfig(**mock_config))

            # Ensure MOS config has same embedder
            mos.config.mem_reader.config.embedder = embedder_config

            with patch("os.path.exists", return_value=True):
                mos.register_mem_cube("test_cube_path", "test_cube_1")

            # Verify no embedder consistency warning was logged
            warning_calls = [
                call
                for call in mock_logger.warning.call_args_list
                if "Cube Embedder is not consistent" in str(call)
            ]
            assert len(warning_calls) == 0, (
                "No embedder consistency warning should be logged when configs match"
            )

            # Verify cube was still registered
            assert "test_cube_1" in mos.mem_cubes
            GeneralMemCube.init_from_dir.assert_called_once_with("test_cube_path")

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_add_memory_content(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test adding memory content."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))
        mos.mem_cubes["test_cube_1"] = mock_mem_cube

        mos.add(memory_content="I like playing basketball", mem_cube_id="test_cube_1")

        mock_mem_cube.text_mem.add.assert_called_once()
        # Verify the added memory item
        added_items = mock_mem_cube.text_mem.add.call_args[0][0]
        assert len(added_items) == 1
        assert added_items[0].memory == "I like playing basketball"

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_add_messages(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test adding messages as memories."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))
        mos.mem_cubes["test_cube_1"] = mock_mem_cube

        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]

        mos.add(messages=messages, mem_cube_id="test_cube_1")

        mock_mem_cube.text_mem.add.assert_called_once()
        # Verify the added memory items
        added_items = mock_mem_cube.text_mem.add.call_args[0][0]
        assert len(added_items) == 2
        assert added_items[0].memory == "Hello"
        assert added_items[1].memory == "Hi there!"

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_get_all_memories(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test getting all memories."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))
        mos.mem_cubes["test_cube_1"] = mock_mem_cube

        result = mos.get_all(mem_cube_id="test_cube_1")

        assert isinstance(result, dict)
        assert "text_mem" in result
        assert len(result["text_mem"]) == 1
        assert result["text_mem"][0]["cube_id"] == "test_cube_1"
        mock_mem_cube.text_mem.get_all.assert_called_once()


class TestMOSChat:
    """Test MOS chat functionality."""

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_chat_with_memories(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test chat functionality with memory search."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))
        mos.mem_cubes["test_cube_1"] = mock_mem_cube
        mos.mem_cubes["test_cube_2"] = mock_mem_cube  # Add the second cube to avoid KeyError

        response = mos.chat("What do I like?")

        # Verify memory search was called (called twice because we have two cubes)
        assert mock_mem_cube.text_mem.search.call_count == 2
        mock_mem_cube.text_mem.search.assert_any_call(
            "What do I like?",
            top_k=5,
            info={
                "user_id": mos.user_id,
                "session_id": mos.session_id,
                "chat_history": mos.chat_history_manager[mos.user_id].chat_history,
            },
        )

        # Verify LLM was called
        mock_llm.generate.assert_called_once()

        # Verify response
        assert response == "This is a test response from the assistant."

        # Verify chat history was updated
        assert len(mos.chat_history_manager["test_user"].chat_history) == 2
        assert mos.chat_history_manager["test_user"].chat_history[1]["role"] == "assistant"
        assert mos.chat_history_manager["test_user"].chat_history[1]["content"] == response

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_chat_with_custom_base_prompt(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
        mock_mem_cube,
    ):
        """Test chat functionality with a custom base prompt."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))
        mos.mem_cubes["test_cube_1"] = mock_mem_cube
        mos.mem_cubes["test_cube_2"] = mock_mem_cube

        custom_prompt = "You are a pirate. Answer as such. User memories: {memories}"
        mos.chat("What do I like?", base_prompt=custom_prompt)

        # Verify that the system prompt passed to the LLM is the custom one
        mock_llm.generate.assert_called_once()
        call_args = mock_llm.generate.call_args[0]
        messages = call_args[0]
        system_prompt = messages[0]["content"]

        assert "You are a pirate." in system_prompt
        assert "You are a knowledgeable and helpful AI assistant." not in system_prompt
        assert "User memories:" in system_prompt
        assert "I like playing football" in system_prompt  # Check if memory is interpolated

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_chat_without_memories(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
    ):
        """Test chat functionality without memory cubes."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        # Modify config to disable textual memory
        config_dict = mock_config.copy()
        config_dict["enable_textual_memory"] = False

        mos = MOSCore(MOSConfig(**config_dict))
        mos.mem_cubes["test_cube_1"] = MagicMock()  # Add the cube to avoid KeyError
        mos.mem_cubes["test_cube_2"] = MagicMock()  # Add the second cube to avoid KeyError

        response = mos.chat("Hello")

        # Verify LLM was called
        mock_llm.generate.assert_called_once()

        # Verify response
        assert response == "This is a test response from the assistant."


# TODO: test clear message


class TestMOSSystemPrompt:
    """Test the _build_system_prompt method in MOSCore."""

    @pytest.fixture
    def mos_core_instance(self, mock_config, mock_user_manager):
        """Fixture to create a MOSCore instance for testing the prompt builder."""
        with patch("memos.mem_os.core.LLMFactory"), patch("memos.mem_os.core.MemReaderFactory"):
            return MOSCore(MOSConfig(**mock_config), user_manager=mock_user_manager)

    def test_build_prompt_with_template_and_memories(self, mos_core_instance):
        """Test prompt with a template and memories."""
        base_prompt = "You are a sales agent. Here are past interactions: {memories}"
        memories = [TextualMemoryItem(memory="User likes blue cars.")]
        prompt = mos_core_instance._build_system_prompt(memories, base_prompt)
        assert "You are a sales agent." in prompt
        assert "1. User likes blue cars." in prompt
        assert "{memories}" not in prompt

    def test_build_prompt_with_template_no_memories(self, mos_core_instance):
        """Test prompt with a template but no memories."""
        base_prompt = "You are a sales agent. Here are past interactions: {memories}"
        prompt = mos_core_instance._build_system_prompt(None, base_prompt)
        assert "You are a sales agent." in prompt
        assert "Here are past interactions:" in prompt
        # The placeholder should be replaced with an empty string
        assert "{memories}" not in prompt
        # Check that the output is clean
        assert prompt.strip() == "You are a sales agent. Here are past interactions:"
        assert "## Memories:" not in prompt

    def test_build_prompt_no_template_with_memories(self, mos_core_instance):
        """Test prompt without a template but with memories (backward compatibility)."""
        base_prompt = "You are a helpful assistant."
        memories = [TextualMemoryItem(memory="User is a developer.")]
        prompt = mos_core_instance._build_system_prompt(memories, base_prompt)
        assert "You are a helpful assistant." in prompt
        assert "## Memories:" in prompt
        assert "1. User is a developer." in prompt

    def test_build_prompt_default_with_memories(self, mos_core_instance):
        """Test default prompt with memories."""
        memories = [TextualMemoryItem(memory="User lives in New York.")]
        prompt = mos_core_instance._build_system_prompt(memories)
        assert "You are a knowledgeable and helpful AI assistant." in prompt
        assert "## Memories:" in prompt
        assert "1. User lives in New York." in prompt

    def test_build_prompt_default_no_memories(self, mos_core_instance):
        """Test default prompt without any memories."""
        prompt = mos_core_instance._build_system_prompt()
        assert "You are a knowledgeable and helpful AI assistant." in prompt
        assert "## Memories:" not in prompt


class TestMOSErrorHandling:
    """Test MOS error handling."""

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_add_without_required_params(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
    ):
        """Test add function without required parameters."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))

        with pytest.raises(AssertionError):
            mos.add()  # No parameters provided

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_search_nonexistent_cube(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
    ):
        """Test search with non-existent cube."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager
        mock_user_manager.get_user_cubes.return_value = []  # No cubes

        mos = MOSCore(MOSConfig(**mock_config))

        result = mos.search("test query")

        # Should return empty results
        assert result["text_mem"] == []
        assert result["act_mem"] == []
        assert result["para_mem"] == []
