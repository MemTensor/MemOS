"""
Unit tests for scheduler and tools endpoints in server_router.

Tests cover:
- /product/scheduler/allstatus
- /product/scheduler/status
- /product/scheduler/task_queue_status
- /product/scheduler/wait
- /product/scheduler/wait/stream
- /product/exist_mem_cube_id
- /product/get_user_names_by_memory_ids
"""

from unittest.mock import Mock, patch

import pytest

from fastapi.testclient import TestClient

from memos.api.product_models import (
    AllStatusResponse,
    AllStatusResponseData,
    StatusResponse,
    StatusResponseItem,
    TaskQueueData,
    TaskQueueResponse,
    TaskSummary,
)


# Patch init_server so we can import server_api without starting the full MemOS stack,
# and keep sklearn and other core dependencies untouched for other tests.
@pytest.fixture(scope="module")
def mock_init_server():
    """Mock init_server before importing server_api."""
    # Create mock components
    mock_components = {
        "graph_db": Mock(),
        "mem_reader": Mock(),
        "llm": Mock(),
        "embedder": Mock(),
        "reranker": Mock(),
        "internet_retriever": Mock(),
        "memory_manager": Mock(),
        "default_cube_config": Mock(),
        "mos_server": Mock(),
        "mem_scheduler": Mock(),
        "feedback_server": Mock(),
        "naive_mem_cube": Mock(),
        "searcher": Mock(),
        "api_module": Mock(),
        "vector_db": None,
        "pref_extractor": None,
        "pref_adder": None,
        "pref_retriever": None,
        "pref_mem": None,
        "online_bot": None,
        "chat_llms": Mock(),
        "redis_client": Mock(),
        "deepsearch_agent": Mock(),
    }
    # Setup graph_db mocks for tools endpoints
    mock_components["graph_db"].exist_user_name.return_value = True
    mock_components["graph_db"].get_user_names_by_memory_ids.return_value = {
        "mem-001": "user_alpha",
        "mem-002": "user_beta",
    }

    with patch("memos.api.handlers.init_server", return_value=mock_components):
        # Import after patching
        from memos.api import server_api

        yield server_api.app


@pytest.fixture
def client(mock_init_server):
    """Create test client for server_api."""
    return TestClient(mock_init_server)


@pytest.fixture
def mock_handlers():
    """Mock all scheduler and tools handlers used by server_router."""
    with (
        patch(
            "memos.api.routers.server_router.handlers.scheduler_handler.handle_scheduler_allstatus"
        ) as mock_allstatus,
        patch(
            "memos.api.routers.server_router.handlers.scheduler_handler.handle_scheduler_status"
        ) as mock_status,
        patch(
            "memos.api.routers.server_router.handlers.scheduler_handler.handle_task_queue_status"
        ) as mock_queue,
        patch(
            "memos.api.routers.server_router.handlers.scheduler_handler.handle_scheduler_wait"
        ) as mock_wait,
        patch(
            "memos.api.routers.server_router.handlers.scheduler_handler.handle_scheduler_wait_stream"
        ) as mock_wait_stream,
        patch("memos.api.routers.server_router.graph_db") as mock_graph_db,
    ):
        # Set up default return values
        mock_allstatus.return_value = AllStatusResponse(
            data=AllStatusResponseData(
                scheduler_summary=TaskSummary(waiting=2, in_progress=1, completed=5, total=8),
                all_tasks_summary=TaskSummary(waiting=2, in_progress=1, completed=5, total=8),
            )
        )

        mock_status.return_value = StatusResponse(
            data=[
                StatusResponseItem(task_id="task_1", status="completed"),
                StatusResponseItem(task_id="task_2", status="in_progress"),
            ]
        )

        mock_queue.return_value = TaskQueueResponse(
            data=TaskQueueData(
                user_id="test_user",
                stream_keys=["stream:test_user:cube1:task"],
                users_count=1,
                pending_tasks_count=3,
                remaining_tasks_count=7,
                pending_tasks_detail=["stream:test_user:cube1:task:3"],
                remaining_tasks_detail=["stream:test_user:cube1:task:7"],
            )
        )

        mock_wait.return_value = {
            "message": "idle",
            "data": {
                "running_tasks": 0,
                "waited_seconds": 1.5,
                "timed_out": False,
                "user_name": "dev_user_01",
            },
        }

        mock_graph_db.exist_user_name.return_value = {"kb_finance_2026": True}
        mock_graph_db.get_user_names_by_memory_ids.return_value = {
            "mem-001": "user_alpha",
            "mem-002": "user_beta",
        }

        yield {
            "allstatus": mock_allstatus,
            "status": mock_status,
            "queue": mock_queue,
            "wait": mock_wait,
            "wait_stream": mock_wait_stream,
            "graph_db": mock_graph_db,
        }


# =============================================================================
# Scheduler: /scheduler/allstatus
# =============================================================================


class TestSchedulerAllStatus:
    """Test /scheduler/allstatus endpoint."""

    def test_valid_input_output(self, mock_handlers, client):
        """Test allstatus endpoint returns correct response structure."""
        response = client.get("/product/scheduler/allstatus")

        assert response.status_code == 200
        data = response.json()
        assert data["code"] == 200
        assert "scheduler_summary" in data["data"]
        assert "all_tasks_summary" in data["data"]
        assert data["data"]["scheduler_summary"]["total"] == 8
        assert data["data"]["scheduler_summary"]["waiting"] == 2
        assert data["data"]["scheduler_summary"]["in_progress"] == 1

    def test_empty_state(self, mock_handlers, client):
        """Test allstatus endpoint with empty scheduler state."""
        mock_handlers["allstatus"].return_value = AllStatusResponse(
            data=AllStatusResponseData(
                scheduler_summary=TaskSummary(total=0),
                all_tasks_summary=TaskSummary(total=0),
            )
        )

        response = client.get("/product/scheduler/allstatus")

        assert response.status_code == 200
        data = response.json()
        assert data["data"]["scheduler_summary"]["total"] == 0


# =============================================================================
# Scheduler: /scheduler/status
# =============================================================================


class TestSchedulerStatus:
    """Test /scheduler/status endpoint."""

    def test_all_tasks_for_user(self, mock_handlers, client):
        """Test status endpoint returns all tasks for a user."""
        response = client.get("/product/scheduler/status?user_id=test_user")

        assert response.status_code == 200
        data = response.json()
        assert data["code"] == 200
        assert len(data["data"]) == 2
        assert data["data"][0]["task_id"] == "task_1"
        assert data["data"][0]["status"] == "completed"

        # Verify handler was called with correct args
        mock_handlers["status"].assert_called_once()
        call_kwargs = mock_handlers["status"].call_args[1]
        assert call_kwargs["user_id"] == "test_user"
        assert call_kwargs["task_id"] is None

    def test_specific_task(self, mock_handlers, client):
        """Test status endpoint with specific task_id."""
        mock_handlers["status"].return_value = StatusResponse(
            data=[StatusResponseItem(task_id="task_999", status="waiting")]
        )

        response = client.get("/product/scheduler/status?user_id=test_user&task_id=task_999")

        assert response.status_code == 200
        data = response.json()
        assert len(data["data"]) == 1
        assert data["data"][0]["status"] == "waiting"

    def test_missing_required_user_id(self, mock_handlers, client):
        """Test status endpoint returns 422 when user_id is missing."""
        response = client.get("/product/scheduler/status")
        assert response.status_code == 422

    def test_empty_task_list(self, mock_handlers, client):
        """Test status endpoint returns empty list for user with no tasks."""
        mock_handlers["status"].return_value = StatusResponse(data=[])

        response = client.get("/product/scheduler/status?user_id=idle_user")

        assert response.status_code == 200
        data = response.json()
        assert data["data"] == []


# =============================================================================
# Scheduler: /scheduler/task_queue_status
# =============================================================================


class TestSchedulerTaskQueueStatus:
    """Test /scheduler/task_queue_status endpoint."""

    def test_returns_queue_metrics(self, mock_handlers, client):
        """Test task_queue_status endpoint returns correct queue metrics."""
        response = client.get("/product/scheduler/task_queue_status?user_id=test_user")

        assert response.status_code == 200
        data = response.json()
        assert data["code"] == 200
        assert data["data"]["user_id"] == "test_user"
        assert data["data"]["pending_tasks_count"] == 3
        assert data["data"]["remaining_tasks_count"] == 7
        assert data["data"]["users_count"] == 1
        assert data["data"]["stream_keys"] == ["stream:test_user:cube1:task"]

        # Verify handler was called with correct args
        mock_handlers["queue"].assert_called_once()
        call_kwargs = mock_handlers["queue"].call_args[1]
        assert call_kwargs["user_id"] == "test_user"

    def test_missing_required_user_id(self, mock_handlers, client):
        """Test task_queue_status endpoint returns 422 when user_id is missing."""
        response = client.get("/product/scheduler/task_queue_status")
        assert response.status_code == 422

    def test_empty_queue(self, mock_handlers, client):
        """Test task_queue_status endpoint with empty queue."""
        mock_handlers["queue"].return_value = TaskQueueResponse(
            data=TaskQueueData(
                user_id="test_user",
                stream_keys=[],
                users_count=0,
                pending_tasks_count=0,
                remaining_tasks_count=0,
                pending_tasks_detail=[],
                remaining_tasks_detail=[],
            )
        )

        response = client.get("/product/scheduler/task_queue_status?user_id=test_user")

        assert response.status_code == 200
        data = response.json()
        assert data["data"]["pending_tasks_count"] == 0
        assert data["data"]["remaining_tasks_count"] == 0


# =============================================================================
# Scheduler: /scheduler/wait
# =============================================================================


class TestSchedulerWait:
    """Test /scheduler/wait endpoint."""

    def test_returns_idle(self, mock_handlers, client):
        """Test wait endpoint returns idle when scheduler is empty."""
        response = client.post(
            "/product/scheduler/wait?user_name=dev_user_01&timeout_seconds=120&poll_interval=0.5",
        )

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "idle"
        assert data["data"]["running_tasks"] == 0
        assert data["data"]["timed_out"] is False

        # Verify handler was called with correct args
        mock_handlers["wait"].assert_called_once()
        call_kwargs = mock_handlers["wait"].call_args[1]
        assert call_kwargs["user_name"] == "dev_user_01"

    def test_returns_timeout(self, mock_handlers, client):
        """Test wait endpoint returns timeout when tasks don't complete."""
        mock_handlers["wait"].return_value = {
            "message": "timeout",
            "data": {
                "running_tasks": 3,
                "waited_seconds": 120.0,
                "timed_out": True,
                "user_name": "dev_user_01",
            },
        }

        response = client.post(
            "/product/scheduler/wait?user_name=dev_user_01&timeout_seconds=60",
        )

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "timeout"
        assert data["data"]["timed_out"] is True

    def test_default_parameters(self, mock_handlers, client):
        """Test wait endpoint uses default timeout and poll_interval."""
        response = client.post(
            "/product/scheduler/wait?user_name=u1",
        )

        assert response.status_code == 200
        mock_handlers["wait"].assert_called_once()
        call_kwargs = mock_handlers["wait"].call_args[1]
        assert call_kwargs["user_name"] == "u1"
        assert call_kwargs["timeout_seconds"] == 120.0
        assert call_kwargs["poll_interval"] == 0.5


# =============================================================================
# Scheduler: /scheduler/wait/stream
# =============================================================================


class TestSchedulerWaitStream:
    """Test /scheduler/wait/stream endpoint."""

    def test_streams_sse_events(self, mock_handlers, client):
        """Test wait/stream endpoint returns SSE events."""
        import json

        def fake_stream():
            for payload in [
                {
                    "user_name": "u1",
                    "active_tasks": 3,
                    "elapsed_seconds": 0.5,
                    "status": "running",
                    "instance_id": "x",
                },
                {
                    "user_name": "u1",
                    "active_tasks": 0,
                    "elapsed_seconds": 1.0,
                    "status": "idle",
                    "instance_id": "x",
                },
            ]:
                yield f"data: {json.dumps(payload)}\n\n"

        from fastapi.responses import StreamingResponse

        mock_handlers["wait_stream"].return_value = StreamingResponse(
            fake_stream(), media_type="text/event-stream"
        )

        response = client.get("/product/scheduler/wait/stream?user_name=u1&timeout_seconds=30")

        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

        # Parse SSE lines
        body = response.text
        lines = [line for line in body.split("\n") if line.startswith("data: ")]
        assert len(lines) == 2
        e1 = json.loads(lines[0][len("data: ") :])
        assert e1["status"] == "running"
        assert e1["active_tasks"] == 3

    def test_missing_required_user_name(self, mock_handlers, client):
        """Test wait/stream endpoint returns 422 when user_name is missing."""
        response = client.get("/product/scheduler/wait/stream")
        assert response.status_code == 422


# =============================================================================
# Tools: /exist_mem_cube_id
# =============================================================================


class TestExistMemCubeId:
    """Test /exist_mem_cube_id endpoint."""

    def test_cube_exists(self, mock_handlers, client):
        """Test exist_mem_cube_id endpoint returns correct dict for existing cube."""
        response = client.post(
            "/product/exist_mem_cube_id",
            json={"mem_cube_id": "kb_finance_2026"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["code"] == 200
        assert data["message"] == "Successfully"
        # data is dict[str, bool]: {cube_id: exists}
        assert data["data"] == {"kb_finance_2026": True}

        # Verify handler was called with correct args
        mock_handlers["graph_db"].exist_user_name.assert_called_once_with(
            user_name="kb_finance_2026"
        )

    def test_returns_422_for_missing_mem_cube_id(self, mock_handlers, client):
        """Test exist_mem_cube_id endpoint returns 422 when mem_cube_id is missing."""
        response = client.post("/product/exist_mem_cube_id", json={})
        assert response.status_code == 422

    def test_cube_does_not_exist(self, mock_handlers, client):
        """Test exist_mem_cube_id endpoint returns False for non-existent cube."""
        mock_handlers["graph_db"].exist_user_name.return_value = {"nonexistent": False}

        response = client.post(
            "/product/exist_mem_cube_id",
            json={"mem_cube_id": "nonexistent"},
        )

        assert response.status_code == 200
        assert response.json()["data"] == {"nonexistent": False}


# =============================================================================
# Tools: /get_user_names_by_memory_ids
# =============================================================================


class TestGetUserNamesByMemoryIds:
    """Test /get_user_names_by_memory_ids endpoint."""

    def test_returns_user_name_mapping(self, mock_handlers, client):
        """Test get_user_names_by_memory_ids returns correct user mapping."""
        response = client.post(
            "/product/get_user_names_by_memory_ids",
            json={
                "memory_ids": [
                    "2f40be8f-736c-4a5f-aada-9489037769e0",
                    "5e92be1a-826d-4f6e-97ce-98b699eebb98",
                ]
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["code"] == 200
        assert data["message"] == "Successfully"
        assert data["data"]["mem-001"] == "user_alpha"
        assert data["data"]["mem-002"] == "user_beta"

        # Verify handler was called with correct args
        mock_handlers["graph_db"].get_user_names_by_memory_ids.assert_called_once()

    def test_returns_422_for_missing_memory_ids(self, mock_handlers, client):
        """Test get_user_names_by_memory_ids returns 422 when memory_ids is missing."""
        response = client.post("/product/get_user_names_by_memory_ids", json={})
        assert response.status_code == 422

    def test_empty_memory_ids(self, mock_handlers, client):
        """Test get_user_names_by_memory_ids with empty list."""
        mock_handlers["graph_db"].get_user_names_by_memory_ids.return_value = {}

        response = client.post(
            "/product/get_user_names_by_memory_ids",
            json={"memory_ids": []},
        )

        assert response.status_code == 200
        assert response.json()["data"] == {}
