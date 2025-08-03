from unittest.mock import Mock, patch

import pytest

from fastapi.testclient import TestClient

from memos.api.start_api import app
from memos.mem_user.user_manager import UserRole


client = TestClient(app)

# Mock data
MOCK_MESSAGE = {"role": "user", "content": "test message"}
MOCK_MEMORY_CREATE = {
    "messages": [MOCK_MESSAGE],
    "mem_cube_id": "test_cube",
    "user_id": "test_user",
}
MOCK_MEMORY_CONTENT = {
    "memory_content": "test memory content",
    "mem_cube_id": "test_cube",
    "user_id": "test_user",
}
MOCK_DOC_PATH = {"doc_path": "/path/to/doc", "mem_cube_id": "test_cube", "user_id": "test_user"}
MOCK_SEARCH_REQUEST = {
    "query": "test query",
    "user_id": "test_user",
    "install_cube_ids": ["test_cube"],
}
MOCK_MEMCUBE_REGISTER = {
    "mem_cube_name_or_path": "test_cube_path",
    "mem_cube_id": "test_cube",
    "user_id": "test_user",
}
MOCK_CHAT_REQUEST = {"query": "test chat query", "user_id": "test_user"}
MOCK_USER_CREATE = {"user_id": "test_user", "user_name": "Test User", "role": "USER"}
MOCK_CUBE_SHARE = {"target_user_id": "target_user"}
MOCK_CONFIG = {
    "user_id": "test_user",
    "session_id": "test_session",
    "enable_textual_memory": True,
    "enable_activation_memory": False,
    "top_k": 5,
    "chat_model": {
        "backend": "openai",
        "config": {
            "model_name_or_path": "gpt-3.5-turbo",
            "api_key": "test_key",
            "temperature": 0.7,
            "api_base": "https://api.openai.com/v1",
        },
    },
}


@pytest.fixture
def mock_mos():
    """Mock MOS instance for testing."""
    with patch("memos.api.start_api.get_mos_instance") as mock_get_mos:
        # Create a mock MOS instance
        mock_instance = Mock()

        # Set up default return values for methods
        mock_instance.search.return_value = {"text_mem": [], "act_mem": [], "para_mem": []}
        mock_instance.get_all.return_value = {"text_mem": [], "act_mem": [], "para_mem": []}
        mock_instance.get.return_value = {"memory": "test memory"}
        mock_instance.chat.return_value = "test response"
        mock_instance.list_users.return_value = []
        mock_instance.get_user_info.return_value = {
            "user_id": "test_user",
            "user_name": "Test User",
            "role": "user",
            "accessible_cubes": [],
        }
        mock_instance.create_user.return_value = "test_user"
        mock_instance.share_cube_with_user.return_value = True

        # Configure the mock to return our mock instance
        mock_get_mos.return_value = mock_instance

        yield mock_instance


def test_configure(mock_mos):
    """Test configuration endpoint."""
    with patch("memos.api.start_api.MOS_INSTANCE", None):
        # Use a valid configuration
        valid_config = {
            "user_id": "test_user",
            "session_id": "test_session",
            "enable_textual_memory": True,
            "enable_activation_memory": False,
            "top_k": 5,
            "chat_model": {
                "backend": "openai",
                "config": {
                    "model_name_or_path": "gpt-3.5-turbo",
                    "api_key": "test_key",
                    "temperature": 0.7,
                    "api_base": "https://api.openai.com/v1",
                },
            },
            "mem_reader": {
                "backend": "simple_struct",
                "config": {
                    "llm": {
                        "backend": "openai",
                        "config": {
                            "model_name_or_path": "gpt-3.5-turbo",
                            "api_key": "test_key",
                            "temperature": 0.7,
                            "api_base": "https://api.openai.com/v1",
                        },
                    },
                    "embedder": {
                        "backend": "sentence_transformer",
                        "config": {"model_name_or_path": "all-MiniLM-L6-v2"},
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
        }
        response = client.post("/configure", json=valid_config)
        assert response.status_code == 200
        assert response.json() == {
            "code": 200,
            "message": "Configuration set successfully",
            "data": None,
        }


def test_configure_error(mock_mos):
    """Test configuration endpoint with error."""
    with patch("memos.api.start_api.MOS_INSTANCE", None):
        response = client.post("/configure", json={})
        assert response.status_code == 422  # FastAPI validation error


def test_create_user(mock_mos):
    """Test user creation endpoint."""
    response = client.post("/users", json=MOCK_USER_CREATE)
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "User created successfully",
        "data": {"user_id": "test_user"},
    }
    mock_mos.create_user.assert_called_once_with(
        user_id="test_user", role=UserRole.USER, user_name="Test User"
    )


def test_create_user_validation_error(mock_mos):
    """Test user creation with validation error."""
    mock_mos.create_user.side_effect = ValueError("Invalid user data")
    response = client.post("/users", json=MOCK_USER_CREATE)
    assert response.status_code == 400
    assert "Invalid user data" in response.json()["message"]


def test_list_users(mock_mos):
    """Test list users endpoint."""
    # Set up mock to return the expected data structure
    mock_users = [
        {
            "user_id": "test_user",
            "user_name": "Test User",
            "role": "user",
            "created_at": "2023-01-01T00:00:00",
            "is_active": True,
        }
    ]
    mock_mos.list_users.return_value = mock_users

    response = client.get("/users")
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "Users retrieved successfully",
        "data": mock_users,
    }
    mock_mos.list_users.assert_called_once()


def test_get_user_info(mock_mos):
    """Test get user info endpoint."""
    # Set up mock to return the expected data structure
    mock_user_info = {
        "user_id": "test_user",
        "user_name": "Test User",
        "role": "user",
        "created_at": "2023-01-01T00:00:00",
        "accessible_cubes": [],
    }
    mock_mos.get_user_info.return_value = mock_user_info

    response = client.get("/users/me")
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "User info retrieved successfully",
        "data": mock_user_info,
    }
    mock_mos.get_user_info.assert_called_once()


def test_register_mem_cube(mock_mos):
    """Test MemCube registration endpoint."""
    response = client.post("/mem_cubes", json=MOCK_MEMCUBE_REGISTER)
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "MemCube registered successfully",
        "data": None,
    }
    mock_mos.register_mem_cube.assert_called_once_with(
        mem_cube_name_or_path="test_cube_path", mem_cube_id="test_cube", user_id="test_user"
    )


def test_register_mem_cube_validation_error(mock_mos):
    """Test MemCube registration with validation error."""
    mock_mos.register_mem_cube.side_effect = ValueError("Invalid MemCube")
    response = client.post("/mem_cubes", json=MOCK_MEMCUBE_REGISTER)
    assert response.status_code == 400
    assert "Invalid MemCube" in response.json()["message"]


def test_unregister_mem_cube(mock_mos):
    """Test MemCube unregistration endpoint."""
    response = client.delete("/mem_cubes/test_cube?user_id=test_user")
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "MemCube unregistered successfully",
        "data": None,
    }
    mock_mos.unregister_mem_cube.assert_called_once_with(
        mem_cube_id="test_cube", user_id="test_user"
    )


def test_unregister_nonexistent_mem_cube(mock_mos):
    """Test unregistering a non-existent MemCube."""
    mock_mos.unregister_mem_cube.side_effect = ValueError("MemCube not found")
    response = client.delete("/mem_cubes/nonexistent_cube")
    assert response.status_code == 400
    assert "MemCube not found" in response.json()["message"]


def test_share_cube(mock_mos):
    """Test cube sharing endpoint."""
    response = client.post("/mem_cubes/test_cube/share", json=MOCK_CUBE_SHARE)
    assert response.status_code == 200
    assert response.json() == {"code": 200, "message": "Cube shared successfully", "data": None}
    mock_mos.share_cube_with_user.assert_called_once_with("test_cube", "target_user")


def test_share_cube_failure(mock_mos):
    """Test cube sharing failure."""
    mock_mos.share_cube_with_user.return_value = False
    response = client.post("/mem_cubes/test_cube/share", json=MOCK_CUBE_SHARE)
    assert response.status_code == 400
    assert "Failed to share cube" in response.json()["message"]


@pytest.mark.parametrize(
    "memory_create,expected_calls",
    [
        (MOCK_MEMORY_CREATE, {"messages": [MOCK_MESSAGE]}),
        (MOCK_MEMORY_CONTENT, {"memory_content": "test memory content"}),
        (MOCK_DOC_PATH, {"doc_path": "/path/to/doc"}),
    ],
)
def test_add_memory(mock_mos, memory_create, expected_calls):
    """Test adding memories with different types of content."""
    response = client.post("/memories", json=memory_create)
    assert response.status_code == 200
    assert response.json() == {"code": 200, "message": "Memories added successfully", "data": None}
    mock_mos.add.assert_called_once()


def test_add_memory_validation_error(mock_mos):
    """Test adding memory with validation error."""
    response = client.post("/memories", json={})
    assert response.status_code == 400
    assert "must be provided" in response.json()["message"]


def test_get_all_memories(mock_mos):
    """Test get all memories endpoint."""
    mock_results = {
        "text_mem": [{"cube_id": "test_cube", "memories": []}],
        "act_mem": [],
        "para_mem": [],
    }
    mock_mos.get_all.return_value = mock_results

    response = client.get("/memories")
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "Memories retrieved successfully",
        "data": mock_results,
    }
    mock_mos.get_all.assert_called_once_with(mem_cube_id=None, user_id=None)


def test_get_memory(mock_mos):
    """Test get specific memory endpoint."""
    mock_memory = {"memory": "test memory content"}
    mock_mos.get.return_value = mock_memory

    response = client.get("/memories/test_cube/test_memory")
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "Memory retrieved successfully",
        "data": mock_memory,
    }
    mock_mos.get.assert_called_once_with(
        mem_cube_id="test_cube", memory_id="test_memory", user_id=None
    )


def test_get_nonexistent_memory(mock_mos):
    """Test getting a non-existent memory."""
    mock_mos.get.side_effect = ValueError("Memory not found")
    response = client.get("/memories/test_cube/nonexistent_memory")
    assert response.status_code == 400
    assert "Memory not found" in response.json()["message"]


def test_search_memories(mock_mos):
    """Test search memories endpoint."""
    # Mock the search method to return a proper result structure
    mock_results = {"text_mem": [], "act_mem": [], "para_mem": []}
    mock_mos.search.return_value = mock_results

    # Ensure the search request has all required fields
    search_request = {
        "query": "test query",
        "user_id": "test_user",
        "install_cube_ids": ["test_cube"],
    }

    response = client.post("/search", json=search_request)
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "Search completed successfully",
        "data": mock_results,
    }
    mock_mos.search.assert_called_once_with(
        query="test query", user_id="test_user", install_cube_ids=["test_cube"]
    )


def test_update_memory(mock_mos):
    """Test updating a memory endpoint."""
    update_data = {"content": "updated content"}
    response = client.put("/memories/test_cube/test_memory?user_id=test_user", json=update_data)
    assert response.status_code == 200
    assert response.json() == {"code": 200, "message": "Memory updated successfully", "data": None}
    mock_mos.update.assert_called_once_with(
        mem_cube_id="test_cube",
        memory_id="test_memory",
        text_memory_item=update_data,
        user_id="test_user",
    )


def test_update_nonexistent_memory(mock_mos):
    """Test updating a non-existent memory."""
    mock_mos.update.side_effect = ValueError("Memory not found")
    response = client.put("/memories/test_cube/nonexistent_memory", json={})
    assert response.status_code == 400
    assert "Memory not found" in response.json()["message"]


def test_delete_memory(mock_mos):
    """Test deleting a memory endpoint."""
    response = client.delete("/memories/test_cube/test_memory?user_id=test_user")
    assert response.status_code == 200
    assert response.json() == {"code": 200, "message": "Memory deleted successfully", "data": None}
    mock_mos.delete.assert_called_once_with(
        mem_cube_id="test_cube", memory_id="test_memory", user_id="test_user"
    )


def test_delete_nonexistent_memory(mock_mos):
    """Test deleting a non-existent memory."""
    mock_mos.delete.side_effect = ValueError("Memory not found")
    response = client.delete("/memories/test_cube/nonexistent_memory")
    assert response.status_code == 400
    assert "Memory not found" in response.json()["message"]


def test_delete_all_memories(mock_mos):
    """Test deleting all memories endpoint."""
    response = client.delete("/memories/test_cube?user_id=test_user")
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "All memories deleted successfully",
        "data": None,
    }
    mock_mos.delete_all.assert_called_once_with(mem_cube_id="test_cube", user_id="test_user")


def test_delete_all_nonexistent_memories(mock_mos):
    """Test deleting all memories from non-existent MemCube."""
    mock_mos.delete_all.side_effect = ValueError("MemCube not found")
    response = client.delete("/memories/nonexistent_cube")
    assert response.status_code == 400
    assert "MemCube not found" in response.json()["message"]


def test_chat(mock_mos):
    """Test chat endpoint."""
    response = client.post("/chat", json=MOCK_CHAT_REQUEST)
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "Chat response generated",
        "data": "test response",
    }
    mock_mos.chat.assert_called_once_with(query="test chat query", user_id="test_user")


def test_chat_without_user_id(mock_mos):
    """Test chat endpoint without user_id."""
    chat_request = {"query": "test chat query"}
    response = client.post("/chat", json=chat_request)
    assert response.status_code == 200
    assert response.json() == {
        "code": 200,
        "message": "Chat response generated",
        "data": "test response",
    }
    mock_mos.chat.assert_called_once_with(query="test chat query", user_id=None)


def test_home_redirect():
    """Test home endpoint redirects to docs."""
    response = client.get("/", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/docs"
