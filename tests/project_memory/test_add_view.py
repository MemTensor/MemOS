from __future__ import annotations

from types import SimpleNamespace

from memos.project_memory.add_acceptance import AddAcceptance
from memos.project_memory.add_view import RelationalProjectView
from memos.project_memory.types import Domain, Space
from tests.project_memory import test_add_store


add_store = test_add_store.add_store


def test_preserves_domain_identity_and_topic_reads(add_store):
    view = RelationalProjectView(add_store)
    view.put_space(
        Space(
            space_id="space",
            project_id="project-a",
            space_name="A",
            domains=[Domain("development")],
        )
    )
    with add_store.transaction() as cursor:
        cursor.execute("SELECT id FROM domains WHERE space_id = 'space'")
        domain_id = cursor.fetchone()["id"]
        cursor.execute(
            """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary, topic_description,
                                   create_time, update_time)
               VALUES ('topic', 'space', %s, 'Release', 'Choose Python', 'Runtime', now(), now())""",
            (domain_id,),
        )
        cursor.execute(
            """INSERT INTO project_entries (id, topic_id, space_id, entry_type, content, time, user_ids)
               VALUES ('decision', 'topic', 'space', 'decision', 'Choose Python', now(), '{member}')"""
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
    view.put_space(
        Space(
            space_id="space",
            project_id="project-a",
            space_name="A",
            domains=[Domain("development")],
        )
    )
    accept = AddAcceptance(add_store)
    accept.accept(
        SimpleNamespace(
            project_id="project-a",
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


def test_spaces_keep_the_project_they_were_created_in(add_store):
    """create_space writes the request's project; later edits keep it, and each Space reads back."""
    from memos.project_memory.judge import ModelHub
    from memos.project_memory.service import ProjectMemoryService

    service = ProjectMemoryService(RelationalProjectView(add_store), ModelHub(llm=None))
    a = service.create_space("project-a", "A", "", [{"name": "development"}])
    b = service.create_space("project-b", "B")
    service.update_space(a.space_id, space_name="A2")
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT id, project_id, space_name FROM spaces ORDER BY space_name")
        rows = [(r["id"], r["project_id"], r["space_name"]) for r in cursor.fetchall()]
    assert rows == [(a.space_id, "project-a", "A2"), (b.space_id, "project-b", "B")]
    assert service.get_space(b.space_id).project_id == "project-b"
    assert service.list_domains(a.space_id) == [{"name": "development", "description": ""}]
