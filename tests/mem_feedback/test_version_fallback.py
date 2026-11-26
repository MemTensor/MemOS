from unittest.mock import Mock

import pytest

from memos.mem_feedback.feedback import MemFeedback
from memos.memories.textual.item import ArchivedTextualMemory, TextualMemoryItem
from memos.plugins import hooks
from memos.plugins.hook_defs import H


@pytest.mark.parametrize("provider_fails", [False, True])
@pytest.mark.parametrize("has_history", [False, True])
def test_version_fallback_preserves_history_across_updates(
    monkeypatch, provider_fails, has_history
):
    monkeypatch.setitem(hooks._hooks, H.MEMORY_VERSION_APPLY_FEEDBACK_UPDATE, [])
    if provider_fails:
        hooks.register_hook(
            H.MEMORY_VERSION_APPLY_FEEDBACK_UPDATE,
            Mock(side_effect=ValueError("provider failed")),
        )
    feedback = MemFeedback.__new__(MemFeedback)
    feedback.mem_reader = Mock(memory_version_switch="on")
    feedback.graph_store = Mock()
    feedback._batch_embed = Mock(return_value=[[0.1]])
    feedback._retry_db_operation = lambda operation: operation()
    feedback._del_working_binding = Mock()
    old = TextualMemoryItem(
        memory="I teach Chinese. I prefer paper books. I will visit Hangzhou.",
        metadata={
            "memory_type": "WorkingMemory",
            "version": 2,
            "history": [{"version": 1, "memory": "Earlier memory"}] if has_history else [],
        },
    )
    original = old.model_dump()
    for version, text in enumerate(
        [
            "I teach math. I prefer paper books. I will visit Hangzhou.",
            "I teach math. I prefer paper books. I will visit Chengdu.",
        ],
        start=3,
    ):
        before = old.model_dump()
        result = feedback._single_update_operation(
            old,
            TextualMemoryItem(memory=text, metadata={"memory_type": "WorkingMemory"}),
            "user-1",
            "cube-1",
            operation={"text": text},
        )
        fields = feedback.graph_store.update_node.call_args.kwargs["fields"]
        assert result["id"] == old.id
        assert fields["memory"] == text
        assert fields["version"] == version
        history = [ArchivedTextualMemory.model_validate(entry) for entry in fields["history"]]
        assert history[:-1] == old.metadata.history
        assert history[-1].memory == old.memory
        assert history[-1].version == version - 1
        assert history[-1].update_type == "feedback"
        assert old.model_dump() == before
        old = old.model_copy(deep=True)
        old.memory = text
        old.metadata.version = version
        old.metadata.history = history
    if has_history:
        assert old.metadata.history[0].memory == original["metadata"]["history"][0]["memory"]
    feedback.graph_store.add_node.assert_not_called()


def test_version_provider_fields_are_used_unchanged(monkeypatch):
    feedback = MemFeedback.__new__(MemFeedback)
    feedback.graph_store = Mock()
    feedback._retry_db_operation = lambda operation: operation()
    feedback._del_working_binding = Mock()
    old = TextualMemoryItem(memory="old")
    new = TextualMemoryItem(id=old.id, memory="new")
    fields = {"memory": "new", "version": 42, "history": []}
    provider = Mock(return_value=(new, None, None, fields))
    monkeypatch.setitem(hooks._hooks, H.MEMORY_VERSION_APPLY_FEEDBACK_UPDATE, [provider])

    assert feedback._single_update_operation_with_versions(old, new, "cube-1") == old.id
    feedback.graph_store.update_node.assert_called_once_with(
        id=old.id, fields=fields, user_name="cube-1"
    )
