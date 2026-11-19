from __future__ import annotations

import pytest

from memos.project_memory.add_acceptance import AddAcceptance
from memos.project_memory.add_legacy_migrate import apply_migration, plan_migration
from memos.project_memory.add_view import RelationalProjectView
from memos.project_memory.types import (
    PROJECT_EPISODE,
    PROJECT_EXPERIENCE,
    PROJECT_MESSAGE,
    PROJECT_SPACE,
    PROJECT_TASK,
    PROJECT_TOPIC,
    ExperienceCard,
)
from tests.project_memory import test_add_store


add_store = test_add_store.add_store
CHAT_TIME = "2026-11-19T10:00:00+08:00"


def _node(kind, identifier, space, memory="", **properties):
    return {
        "id": identifier,
        "memory": memory,
        "metadata": {
            "memory_type": kind,
            "user_name": space,
            "status": "activated",
            "created_at": CHAT_TIME,
            "updated_at": CHAT_TIME,
            **properties,
        },
    }


def _legacy_snapshot():
    space = "legacy-space"
    card = ExperienceCard(
        id="experience",
        space_id=space,
        principle="Run tests",
        time=CHAT_TIME,
        topic_ids=["topic-a", "topic-b"],
    )
    orphan = ExperienceCard(id="orphan", space_id=space, principle="Keep a backup", time=CHAT_TIME)
    return [
        _node(PROJECT_SPACE, space, space, space_name="Legacy", domains=[{"name": "development"}]),
        _node(PROJECT_TOPIC, "topic-a", space, domain="development", topic_name="Build"),
        _node(PROJECT_TOPIC, "topic-b", space, domain="development", topic_name="Test"),
        _node(PROJECT_EXPERIENCE, "experience", space, **card.to_props()),
        _node(PROJECT_EXPERIENCE, "orphan", space, **orphan.to_props()),
        _node(
            PROJECT_MESSAGE,
            "node-message",
            space,
            "Run the tests",
            conversation_id="chat",
            message_id="message",
            role="member",
            role_id="owner",
            chat_time=CHAT_TIME,
        ),
        _node(
            PROJECT_TASK,
            "task",
            "__project_memory_index__",
            task_id="task",
            user_id="owner",
            create_time=CHAT_TIME,
            space_ids=[space],
            message_ids=["node-message"],
            memory_ids=["topic-b"],
            status="completed",
        ),
        _node(
            PROJECT_EPISODE,
            "episode",
            space,
            conversation_id="chat",
            message_ids=["node-message"],
            episode_state="closed",
            topic_id="topic-b",
            domains=["development"],
            create_time=CHAT_TIME,
        ),
    ]


def test_migration_preserves_identity_and_archives_exceptions(add_store):
    plan = plan_migration(_legacy_snapshot(), {"legacy-space": "project-a"}, "project-a")
    assert plan.report()["counts"]["messages"] == 1
    apply_migration(add_store, plan)
    view = RelationalProjectView(add_store, legacy=plan.archive)
    assert view.get_space("legacy-space").domain_names() == ["development"]
    assert view.get_experience("experience", "legacy-space").topic_ids == ["topic-a", "topic-b"]
    assert view.get_experience("orphan", "legacy-space").principle == "Keep a backup"
    episode = add_store.load_episode("episode")
    assert episode["outcome"] == "committed"
    assert episode["messages"][0]["origin_task_id"] == "task"
    assert AddAcceptance(add_store).status("task", "owner")["memory_views"]["project"][
        "memory_ids"
    ] == ["topic-b"]
    with pytest.raises(ValueError, match="already exists"):
        apply_migration(add_store, plan)
    assert len(view.list_topics("legacy-space")) == 2


def test_migration_requires_a_trusted_scope_mapping():
    with pytest.raises(ValueError, match="mapping"):
        plan_migration(_legacy_snapshot(), {}, "project-a")


def test_partial_legacy_episode_is_readable_without_being_resubmitted(add_store):
    source = _legacy_snapshot()
    next(node for node in source if node["id"] == "episode")["metadata"]["episode_state"] = (
        "pending"
    )
    task = next(node for node in source if node["id"] == "task")
    task["metadata"]["status"] = "in_progress"
    plan = plan_migration(source, {"legacy-space": "project-a"}, "project-a")
    assert any(exception["id"] == "episode" for exception in plan.report()["archive_only"])
    assert plan.episodes == []
    apply_migration(add_store, plan)
    view = RelationalProjectView(add_store, legacy=plan.archive)
    assert [message.id for message in view.list_messages("legacy-space", "chat")] == ["message"]
    assert view.legacy_task_status("task", "other") is None
    assert view.legacy_task_status("task", "owner")["status"] == "failed"
    view.clear_space_topics("legacy-space")
    assert view.legacy_task_status("task", "owner") is None
    assert view.list_messages("legacy-space", "chat") == []
