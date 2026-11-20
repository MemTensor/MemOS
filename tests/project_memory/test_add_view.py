from __future__ import annotations

from types import SimpleNamespace

from memos.project_memory.add_acceptance import AddAcceptance
from memos.project_memory.add_view import RelationalProjectView
from memos.project_memory.types import Domain, Space
from tests.project_memory import test_add_store


add_store = test_add_store.add_store


def test_preserves_domain_identity_and_topic_reads(add_store):
    view = RelationalProjectView(add_store)
    view.put_space(Space(space_id="space", space_name="A", domains=[Domain("development")]))
    with add_store.transaction() as cursor:
        cursor.execute("SELECT id FROM domains WHERE space_id = 'space'")
        domain_id = cursor.fetchone()["id"]
        cursor.execute(
            """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary, topic_description,
                                   create_time, update_time, decisions)
               VALUES ('topic', 'space', %s, 'Release', 'Choose Python', 'Runtime', now(), now(),
                 '[{"id": "decision", "content": "Choose Python", "user_ids": ["member"]}]')""",
            (domain_id,),
        )
        cursor.execute(
            """INSERT INTO topic_items (id, topic_id, space_id, kind, content, time, topic_version)
               VALUES ('decision', 'topic', 'space', 'decision', 'Choose Python', now(), 1)"""
        )
    space = view.get_space("space")
    space.domains[0].name = "deployment"
    view.put_space(space)
    assert view.get_space("space").domain_names() == ["deployment"]
    assert view.get_topic("topic").domain == "deployment"
    assert view.get_decision("decision", "space").content == "Choose Python"
    assert view.get_topic("topic", "wrong-space") is None


def test_clear_fences_open_episodes(add_store):
    view = RelationalProjectView(add_store)
    view.put_space(Space(space_id="space", space_name="A", domains=[Domain("development")]))
    accept = AddAcceptance(add_store)
    accept.accept(
        SimpleNamespace(
            user_id="member",
            space_ids=["space"],
            conversation_id="chat",
            task_id="task",
            messages=[{"role": "user", "content": "Project notes"}],
        )
    )
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT id FROM episodes")
        episode_id = cursor.fetchone()["id"]
    view.clear_space_topics("space")
    episode = add_store.load_episode(episode_id)
    assert episode["cleared_at"] >= episode["opened_at"]
    assert episode["closed_at"] == episode["cleared_at"]
    assert episode["outcome"] == "failed"
    assert episode["error"]["reason"] == "SPACE_CLEARED"
