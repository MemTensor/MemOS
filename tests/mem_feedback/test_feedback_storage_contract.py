"""Regression branches around the Feedback boundaries changed for storage errors."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.exceptions import GraphDBError
from memos.mem_feedback.simple_feedback import SimpleMemFeedback
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager


@pytest.fixture
def feedback():
    f = SimpleMemFeedback(Mock(), Mock(), Mock(), Mock(), Mock(), Mock(), Mock())
    f._generate_answer = Mock(return_value="answer")
    f._keyword_replace_judgement = Mock(return_value=None)
    f._pure_add = Mock(return_value={"record": {"add": ["new"], "update": []}})
    f._feedback_judgement = Mock(return_value=None)
    f._batch_embed = Mock(side_effect=lambda texts: [[1, 0, 0] for _ in texts])
    f._feedback_memory = Mock(return_value={"record": {"add": [], "update": ["changed"]}})
    return f


@pytest.mark.parametrize(
    "judge",
    [
        None,
        {"if_keyword_replace": "false"},
        {"if_keyword_replace": "true", "original": "NONE"},
        {"if_keyword_replace": "true", "original": "word", "target": "NONE"},
    ],
)
def test_nonkeyword_pure_add_contract(feedback, judge):
    feedback._keyword_replace_judgement.return_value = judge
    assert feedback.process_feedback_core(
        "u", "A", [], "fact", {"agent_id": "a"}, feedback_time="2026-01-01"
    )["record"]["add"] == ["new"]


@pytest.mark.parametrize(
    "judgements,expected",
    [
        (None, []),
        ([], []),
        ([{"validity": "false", "user_attitude": "irrelevant"}], ["new"]),
        ([{"validity": "false", "user_attitude": "negative"}], []),
        ([{"validity": "true"}], []),
        ([{"validity": "true", "corrected_info": ""}], []),
        ([{"validity": "true", "corrected_info": "fact"}], []),
        ([{"validity": "true", "corrected_info": "fact", "key": "k"}], []),
    ],
)
def test_core_no_valid_feedback_or_irrelevant(feedback, judgements, expected):
    feedback._feedback_judgement.return_value = judgements
    result = feedback.process_feedback_core(
        "u", "A", [{"role": "user", "content": "history"}], "feedback"
    )
    assert result["record"]["add"] == expected and result["record"]["update"] == []


def test_core_valid_memory_and_empty_input(feedback):
    assert feedback.process_feedback_core("u", "A", [], "   ") == {
        "record": {"add": [], "update": []}
    }
    feedback._feedback_judgement.return_value = [
        {"validity": "true", "corrected_info": "fact", "key": "k", "tags": ["x"]},
        {},
    ]
    result = feedback.process_feedback_core(
        "u",
        "A",
        [{"role": "user", "content": "history"}],
        "feedback",
        feedback_time="2026-01-01T00:00:00",
        session_id="s",
    )
    assert result == {"record": {"add": [], "update": ["changed"]}}
    mem = feedback._feedback_memory.call_args.args[2][0]
    assert (
        mem.memory == "fact" and mem.metadata.tags == ["x"] and mem.metadata.embedding == [1, 0, 0]
    )
    feedback._keyword_replace_judgement.side_effect = RuntimeError("model unavailable")
    assert feedback.process_feedback_core("u", "A", [], "feedback") == {
        "record": {"add": [], "update": []}
    }


@pytest.mark.parametrize("error", [TimeoutError("timeout"), RuntimeError("model unavailable")])
def test_feedback_optional_errors_keep_fallback(feedback, error):
    feedback.process_feedback_core = Mock(side_effect=error)
    assert feedback.process_feedback("u", "A", [], "feedback") == {
        "answer": "",
        "record": {"add": [], "update": []},
    }


def test_feedback_pending_future_cancellation(feedback, monkeypatch):
    pending = Mock()
    monkeypatch.setattr(
        "memos.mem_feedback.feedback.concurrent.futures.wait",
        lambda *args, **kwargs: (set(), {pending}),
    )
    feedback.process_feedback_core = Mock(return_value={"record": {"add": [], "update": []}})
    assert feedback.process_feedback("u", "A", [], "feedback")["answer"] == "answer"
    pending.cancel.assert_called_once()


@pytest.mark.parametrize(
    "original,tokenized,has_hits", [("old word", ["old", "word"], False), ("旧词", ["旧词"], True)]
)
def test_existing_tfidf_branch_is_only_stub_regression(
    feedback, original, tokenized, has_hits, monkeypatch
):
    feedback.DB_IDX_READY = True
    monkeypatch.setattr(
        "memos.mem_feedback.feedback.detect_lang", lambda text: "zh" if original == "旧词" else "en"
    )
    feedback._tokenize_chinese = Mock(return_value=tokenized)
    feedback.graph_store.search_by_keywords_tfidf.return_value = [{"id": "one"}] if has_hits else []
    feedback.graph_store.search_by_fulltext.return_value = []
    memory = TextualMemoryItem(memory=original, metadata={"tags": [original, "new"]})
    feedback.graph_store.get_node.return_value = memory.model_dump()
    feedback._single_update_operation = Mock(return_value={"id": memory.id})
    feedback._doc_filter = Mock(side_effect=lambda scope, memories: memories)
    result = feedback.process_keyword_replace(
        "u", "A", {"original": original, "target": "new", "doc_scope": "doc"}
    )
    assert len(result["record"]["update"]) == int(has_hits)
    feedback.graph_store.search_by_keywords_like.assert_not_called()


@pytest.mark.parametrize(
    "text,tags,fail",
    [("no match", [], False), ("old text", [], False), ("old text", ["old", "new"], True)],
)
def test_keyword_replace_filter_tags_and_optional_update_failure(feedback, text, tags, fail):
    memory = TextualMemoryItem(memory=text, metadata={"tags": tags})
    feedback.graph_store.search_by_keywords_like.return_value = [{"id": memory.id}]
    feedback.graph_store.get_node.return_value = memory.model_dump()
    feedback._single_update_operation = (
        Mock(side_effect=RuntimeError("optional failure"))
        if fail
        else Mock(return_value={"id": memory.id})
    )
    result = feedback.process_keyword_replace(
        "u", "A", {"original": "old", "target": "new"}, info={"ignored": 1}
    )
    assert len(result["record"]["update"]) == int("old" in text and not fail)
    if "old" in text:
        new = feedback._single_update_operation.call_args.args[1]
        assert new.memory == "new text" and new.metadata.tags == ["new"]


@pytest.fixture
def manager():
    m = MemoryManager.__new__(MemoryManager)
    m.reorganizer = Mock()
    m.memory_size = {"WorkingMemory": 20}
    m.graph_store = Mock()
    m._add_memory_to_db = Mock(return_value="working")
    m._add_to_graph_memory = Mock(return_value="graph")
    return m


@pytest.mark.parametrize(
    "kind,result",
    [
        ("WorkingMemory", []),
        ("Context", []),
        ("RawFileMemory", ["graph"]),
        ("LongTermMemory", ["graph"]),
    ],
)
def test_manager_selected_kinds(manager, kind, result):
    assert (
        manager._process_memory(
            SimpleNamespace(id="id", metadata=SimpleNamespace(memory_type=kind)), "A"
        )
        == result
    )


@pytest.mark.parametrize("stage", ["working", "graph"])
@pytest.mark.parametrize(
    "failure", [GraphDBError("storage"), ValueError("input"), RuntimeError("optional")]
)
def test_manager_update_failure_kind(manager, stage, failure):
    target = manager._add_memory_to_db if stage == "working" else manager._add_to_graph_memory
    target.side_effect = failure
    memory = TextualMemoryItem(memory="one", metadata={"memory_type": "LongTermMemory"})
    if isinstance(failure, GraphDBError | ValueError):
        with pytest.raises(type(failure)):
            manager._process_memory(memory, "A")
    else:
        assert manager._process_memory(memory, "A") == (["graph"] if stage == "working" else [])


@pytest.mark.parametrize("result", [None, ""])
def test_manager_non_id_result(manager, result):
    manager._add_to_graph_memory.return_value = result
    assert (
        manager._process_memory(
            TextualMemoryItem(memory="one", metadata={"memory_type": "RawFileMemory"}), "A"
        )
        == []
    )


def test_manager_parallel_optional_failure_and_empty(manager):
    manager._process_memory = Mock(return_value=["id"])
    assert manager._add_memories_parallel([Mock()], "A") == ["id"]
    assert manager._add_memories_parallel([], "A") == []
    manager._process_memory.side_effect = RuntimeError("optional")
    assert manager._add_memories_parallel([Mock()], "A") == []
    manager._cleanup_working_memory("A")
    manager.graph_store.remove_oldest_memory.side_effect = RuntimeError("optional")
    manager._cleanup_working_memory("A")


def test_scheduler_feedback_optional_errors_and_empty_batch(monkeypatch):
    from memos.mem_scheduler.task_schedule_modules.handlers.feedback_handler import (
        FeedbackMessageHandler,
    )

    handler = FeedbackMessageHandler(Mock())
    handler.process_single_feedback = Mock()
    handler.batch_handler("u", "A", [Mock()])
    handler.batch_handler("u", "A", [])
    handler.process_single_feedback.side_effect = RuntimeError("optional")
    handler.batch_handler("u", "A", [Mock()])
    monkeypatch.setattr(
        "memos.mem_scheduler.task_schedule_modules.base_handler.group_messages_by_user_and_mem_cube",
        lambda **kw: {"u": {"empty": [], "A": [Mock()]}},
    )
    operation = Mock(side_effect=RuntimeError("optional"))
    handler.handle_exception = Mock()
    handler.process_grouped_messages([], operation)
    handler.handle_exception.assert_called_once()
    operation.side_effect = None
    handler.process_grouped_messages([], operation)
