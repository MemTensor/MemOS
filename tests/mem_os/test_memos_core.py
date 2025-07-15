import warnings

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from memos.configs.mem_os import MOSConfig
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
        assert mos.mem_cubes == {}
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
        assert users[0]["role"] == "user"


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

        with patch("memos.mem_os.core.GeneralMemCube") as mock_general_cube:
            mock_general_cube.init_from_dir.return_value = mock_mem_cube

            mos = MOSCore(MOSConfig(**mock_config))

            with patch("os.path.exists", return_value=True):
                mos.register_mem_cube("test_cube_path", "test_cube_1")

            assert "test_cube_1" in mos.mem_cubes
            mock_general_cube.init_from_dir.assert_called_once_with("test_cube_path")

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
        mock_mem_cube.text_mem.search.assert_called_once_with("football", top_k=5)

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
        mock_mem_cube.text_mem.search.assert_any_call("What do I like?", top_k=5)

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

    @patch("memos.mem_os.core.UserManager")
    @patch("memos.mem_os.core.MemReaderFactory")
    @patch("memos.mem_os.core.LLMFactory")
    def test_clear_messages(
        self,
        mock_llm_factory,
        mock_reader_factory,
        mock_user_manager_class,
        mock_config,
        mock_llm,
        mock_mem_reader,
        mock_user_manager,
    ):
        """Test clearing chat history."""
        # Setup mocks
        mock_llm_factory.from_config.return_value = mock_llm
        mock_reader_factory.from_config.return_value = mock_mem_reader
        mock_user_manager_class.return_value = mock_user_manager

        mos = MOSCore(MOSConfig(**mock_config))

        # Add some chat history
        mos.chat_history_manager["test_user"].chat_history.append(
            {"role": "user", "content": "Hello"}
        )
        mos.chat_history_manager["test_user"].chat_history.append(
            {"role": "assistant", "content": "Hi"}
        )

        assert len(mos.chat_history_manager["test_user"].chat_history) == 2

        mos.clear_messages()

        assert len(mos.chat_history_manager["test_user"].chat_history) == 0
        assert mos.chat_history_manager["test_user"].user_id == "test_user"


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
