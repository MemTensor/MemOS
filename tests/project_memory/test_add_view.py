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
            """INSERT INTO project_entries (id, topic_id, space_id, entry_type, content, chat_time,
                                           user_ids)
               VALUES ('decision', 'topic', 'space', 'decision', 'Choose Python', now(),
                       '{member}')"""
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
    with add_store.transaction() as cursor:
        cursor.execute(
            "UPDATE spaces SET formation_version = 4, last_formation_time = now() WHERE id = 'space'"
        )
    view.clear_space_topics("space")
    episode = add_store.load_episode(episode_id)
    assert episode["cleared_at"] >= episode["opened_at"]
    assert episode["closed_at"] == episode["cleared_at"]
    assert episode["close_reason"] == "space_cleared"
    assert episode["outcome"] == "failed" and episode["stage"] == "done"
    assert episode["error"]["reason"] == "SPACE_CLEARED"
    space = add_store.read_space("space")
    assert space["formation_version"] == 5 and space["last_formation_time"] is None
    # A new message after the clear opens an Episode without a predecessor from before it.
    accept.accept(
        SimpleNamespace(
            project_id="project-a",
            user_id="member",
            space_ids=["space"],
            conversation_id="chat",
            task_id="later",
            messages=[{"role": "user", "content": "More notes"}],
        )
    )
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT previous_episode_id FROM episodes WHERE id <> %s", (episode_id,))
        assert cursor.fetchone()["previous_episode_id"] is None


def test_staged_episodes_follow_domain_renames_and_clear(add_store):
    view = RelationalProjectView(add_store)
    view.put_space(
        Space(space_id="space", project_id="project-a", space_name="A", domains=[Domain("dev")])
    )
    accept = AddAcceptance(add_store)
    (closed,) = accept.accept(
        SimpleNamespace(
            project_id="project-a",
            user_id="member",
            space_ids=["space"],
            task_id="task",
            messages=[{"role": "user", "content": "Notes"}],
        )
    ).closed_episode_ids
    with add_store.transaction() as cursor:
        cursor.execute(
            """UPDATE add_jobs SET stage = 'done', outcome = 'staged',
                      organize_result = organize_result || '{"staged": {"status": "active",
                                                                        "domain": "dev"}}'
               WHERE episode_id = %s""",
            (closed,),
        )
    space = view.get_space("space")
    space.domains[0].name = "development"
    view.put_space(space)
    (staged,) = add_store.read_staged("space")
    assert staged["staged_domain"] == "development"
    assert staged["domains"] == ["development"]
    view.clear_space_topics("space")
    assert add_store.read_staged("space") == []
    assert add_store.load_episode(closed)["staged_status"] == "archived"


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


def test_get_memory_lists_important_topics_before_newer_quiet_ones(add_store):
    from memos.project_memory.judge import ModelHub
    from memos.project_memory.service import ProjectMemoryService

    view = RelationalProjectView(add_store)
    view.put_space(Space(space_id="space", project_id="p", space_name="A", domains=[Domain("dev")]))
    with add_store.transaction() as cursor:
        cursor.execute("SELECT id FROM domains WHERE space_id = 'space'")
        domain_id = cursor.fetchone()["id"]
        # "quiet" is newer, but "busy" carries an importance bonus that outranks it.
        for tid, hours_ago, rank_hours_ago in (("quiet", 1, 1), ("busy", 6, -66)):
            cursor.execute(
                """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary,
                                       topic_description, create_time, update_time, extra)
                   VALUES (%s, 'space', %s, %s, '', '', now(), now() - %s * interval '1 hour',
                           jsonb_build_object('rank_time',
                               to_char((now() - %s * interval '1 hour') AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS"+00:00"')))""",
                (tid, domain_id, tid, hours_ago, rank_hours_ago),
            )
        cursor.execute(
            """INSERT INTO project_entries (id, topic_id, space_id, entry_type, content,
                                           chat_time, user_ids)
               VALUES ('old', 'busy', 'space', 'decision', 'Older, one member',
                       now() - interval '2 hour', '{a}'),
                      ('wide', 'busy', 'space', 'decision', 'Agreed by two',
                       now() - interval '3 hour', '{a,b}'),
                      ('new', 'busy', 'space', 'decision', 'Newest, one member',
                       now() - interval '1 hour', '{a}')"""
        )
    service = ProjectMemoryService(view, ModelHub(llm=None))
    out = service.list_topics(SimpleNamespace(space_id="space", filter=None, size=None, page=1))
    assert [t["id"] for t in out["topic_detail_list"]] == ["busy", "quiet"]
    assert [d["id"] for d in out["topic_detail_list"][0]["decisions"]] == ["wide", "new", "old"]
