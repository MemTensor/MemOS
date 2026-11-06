"""Required Feedback storage failures remain visible across all boundaries."""

from unittest.mock import Mock

import pytest

from memos.exceptions import GraphDBError
from memos.mem_feedback.simple_feedback import SimpleMemFeedback
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager


@pytest.fixture
def feedback():
    fb = SimpleMemFeedback(Mock(), Mock(), Mock(), Mock(), Mock(), Mock(), Mock())
    fb._generate_answer = Mock(return_value="answer")
    fb._keyword_replace_judgement = Mock(
        return_value={"if_keyword_replace": "true", "original": "old", "target": "new"}
    )
    return fb


@pytest.mark.parametrize("failure", [GraphDBError("storage"), ValueError("input")])
@pytest.mark.parametrize("stage", ["read", "update"])
def test_feedback_default_errors_reach_caller(feedback, failure, stage):
    if stage == "read":
        feedback.graph_store.search_by_keywords_like.side_effect = failure
    else:
        memory = TextualMemoryItem(memory="old word", metadata={"tags": ["old"]})
        feedback.graph_store.search_by_keywords_like.return_value = [{"id": memory.id}]
        feedback.graph_store.get_node.return_value = memory.model_dump()
        feedback._batch_embed = Mock(return_value=[[1, 0, 0]])
        feedback._single_update_operation = Mock(side_effect=failure)
    with pytest.raises(type(failure)) as caught:
        feedback.process_feedback("u", "A", [], "replace old by new")
    assert caught.value is failure


@pytest.mark.parametrize(
    "method", ["_add_memories_parallel", "_process_memory", "_cleanup_working_memory"]
)
@pytest.mark.parametrize("failure", [GraphDBError("storage"), ValueError("input")])
def test_manager_required_failure_reaches_feedback(method, failure):
    manager = MemoryManager.__new__(MemoryManager)
    manager.reorganizer = Mock()
    manager.memory_size = {"WorkingMemory": 20}
    manager.graph_store = Mock(remove_oldest_memory=Mock(side_effect=failure))
    manager._add_memory_to_db = Mock(side_effect=failure)
    manager._add_to_graph_memory = Mock(return_value="done")
    memory = TextualMemoryItem(memory="old", metadata={"memory_type": "LongTermMemory"})
    if method == "_add_memories_parallel":
        manager._process_memory = Mock(side_effect=failure)
    args = (
        []
        if method == "_cleanup_working_memory"
        else [memory if method == "_process_memory" else [memory]]
    )
    with pytest.raises(type(failure)) as caught:
        getattr(manager, method)(*args, user_name="A")
    assert caught.value is failure


def test_same_identity_working_write_finishes_before_graph_submission(monkeypatch):
    manager = MemoryManager.__new__(MemoryManager)
    manager.reorganizer = Mock()
    manager._add_memory_to_db = Mock(return_value="working")
    manager._add_to_graph_memory = Mock(return_value="long")
    events = []

    class Future:
        def __init__(self, fn, args, kwargs):
            self.fn, self.args, self.kwargs = fn, args, kwargs

        def result(self):
            result = self.fn(*self.args, **self.kwargs)
            events.append("working_done" if self.fn is manager._add_memory_to_db else "graph_done")
            return result

    class Executor:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def submit(self, fn, *args, **kwargs):
            if fn is manager._add_to_graph_memory:
                assert "working_done" in events
            return Future(fn, args, kwargs)

    monkeypatch.setattr(
        "memos.memories.textual.tree_text_memory.organize.manager.ContextThreadPoolExecutor",
        Executor,
    )
    assert manager._process_memory(
        TextualMemoryItem(memory="one", metadata={"memory_type": "LongTermMemory"}), "A"
    ) == ["long"]


@pytest.mark.parametrize("error", [GraphDBError("uncertain write"), ValueError("invalid")])
def test_storage_write_is_not_retried_or_wrapped(feedback, error):
    operation = Mock(side_effect=error)
    with pytest.raises(type(error)) as caught:
        feedback._retry_db_operation(operation)
    assert caught.value is error
    operation.assert_called_once()


@pytest.mark.parametrize("error", [GraphDBError("storage"), ValueError("input")])
def test_scheduler_feedback_batch_does_not_report_storage_success(error):
    from memos.mem_scheduler.task_schedule_modules.handlers.feedback_handler import (
        FeedbackMessageHandler,
    )

    handler = FeedbackMessageHandler.__new__(FeedbackMessageHandler)
    handler.process_single_feedback = Mock(side_effect=error)
    with pytest.raises(type(error)) as caught:
        handler.batch_handler("u", "A", [Mock()])
    assert caught.value is error


@pytest.mark.parametrize("error", [GraphDBError("storage"), ValueError("input")])
def test_scheduler_group_boundary_does_not_swallow_required_error(error):
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
    from memos.mem_scheduler.task_schedule_modules.handlers.feedback_handler import (
        FeedbackMessageHandler,
    )

    handler = FeedbackMessageHandler(Mock())
    handler.batch_handler = Mock(side_effect=error)
    msg = ScheduleMessageItem(user_id="u", mem_cube_id="A", label="mem_feedback", content="{}")
    with pytest.raises(type(error)) as caught:
        handler([msg])
    assert caught.value is error
