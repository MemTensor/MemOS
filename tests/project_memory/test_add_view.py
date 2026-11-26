from __future__ import annotations

from types import SimpleNamespace

import pytest

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


def test_delete_topics_by_id_across_spaces(add_store):
    """Topics are deleted by ID wherever they are; entries cascade, unknown IDs are ignored."""
    view = RelationalProjectView(add_store)
    for space_id in ("s1", "s2"):
        view.put_space(
            Space(space_id=space_id, project_id="p", space_name=space_id, domains=[Domain("dev")])
        )
    with add_store.transaction() as cursor:
        for topic_id, space_id in (("topic_a", "s1"), ("topic_keep", "s1"), ("topic_b", "s2")):
            cursor.execute(
                """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary,
                                       topic_description, create_time, update_time)
                   SELECT %s, %s, id, 'T', '', '', now(), now() FROM domains WHERE space_id = %s""",
                (topic_id, space_id, space_id),
            )
            cursor.execute(
                """INSERT INTO project_entries (id, topic_id, space_id, entry_type, content,
                                               chat_time, user_ids)
                   VALUES (%s, %s, %s, 'decision', 'D', now(), '{member}')""",
                (f"decision_of_{topic_id}", topic_id, space_id),
            )

    assert view.delete_topics_by_id(["topic_b", "topic_a", "topic_a", "topic_gone"]) == [
        "topic_a",
        "topic_b",
    ]
    assert view.delete_topics_by_id([]) == []
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT id FROM topics ORDER BY id")
        assert [row["id"] for row in cursor.fetchall()] == ["topic_keep"]
        cursor.execute("SELECT topic_id FROM project_entries ORDER BY topic_id")
        assert [row["topic_id"] for row in cursor.fetchall()] == ["topic_keep"]
    # Spaces and domains stay
    assert view.get_space("s2").domain_names() == ["dev"]


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
    (domain,) = service.list_domains(a.space_id)
    assert domain == {
        "domain_id": a.domains[0].domain_id,
        "name": "development",
        "description": "",
    }
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT id FROM domains WHERE space_id = %s", (a.space_id,))
        assert [r["id"] for r in cursor.fetchall()] == [domain["domain_id"]]


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


def test_domains_are_addressed_by_id(add_store):
    """Updates and deletes locate a domain by its ID; a rename keeps the ID and the Topic link."""
    from memos.project_memory.judge import ModelHub
    from memos.project_memory.service import ProjectMemoryService

    service = ProjectMemoryService(RelationalProjectView(add_store), ModelHub(llm=None))
    a = service.create_space("project-a", "A", "", [{"name": "development"}, {"name": "design"}])
    b = service.create_space("project-a", "B", "", [{"name": "development"}])
    ids = {d["name"]: d["domain_id"] for d in service.list_domains(a.space_id)}
    created = service.create_domains(a.space_id, [{"name": "testing"}, {"name": "design"}])
    # The whole list comes back: the new domain with a fresh ID, the skipped one with its own.
    by_name = {d["name"]: d["domain_id"] for d in created}
    assert set(by_name) == {"development", "design", "testing"}
    assert by_name["design"] == ids["design"] and by_name["development"] == ids["development"]
    testing_id = by_name["testing"]
    assert testing_id and testing_id not in ids.values()
    assert {d["domain_id"] for d in service.list_domains(a.space_id)} == {*ids.values(), testing_id}

    with add_store.transaction() as cursor:
        cursor.execute(
            """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary, topic_description,
                                   create_time, update_time)
               VALUES ('topic', %s, %s, 'Release', '', '', now(), now())""",
            (a.space_id, ids["development"]),
        )
    assert (
        service.update_domains(
            a.space_id, [{"domain_id": ids["development"], "new_name": "engineering"}]
        )
        is None
    )
    after = {d["domain_id"]: d["name"] for d in service.list_domains(a.space_id)}
    assert after[ids["development"]] == "engineering"
    assert service.store.get_topic("topic").domain == "engineering"

    # A domain of another Space cannot be changed or removed through this one.
    other_id = service.list_domains(b.space_id)[0]["domain_id"]
    with pytest.raises(ValueError, match="领域未登记"):
        service.update_domains(a.space_id, [{"domain_id": other_id, "new_name": "x"}])
    with pytest.raises(ValueError, match="领域仍被主题引用"):
        service.delete_domains(a.space_id, [ids["development"], testing_id])
    assert len(service.list_domains(a.space_id)) == 3
    assert service.delete_domains(a.space_id, [testing_id, other_id, "missing"]) is None
    assert {d["domain_id"]: d["name"] for d in service.list_domains(a.space_id)} == {
        ids["development"]: "engineering",
        ids["design"]: "design",
    }
    assert [d["name"] for d in service.list_domains(b.space_id)] == ["development"]


def test_put_space_never_takes_over_a_domain_of_another_space(add_store):
    view = RelationalProjectView(add_store)
    view.put_space(
        Space(space_id="s1", project_id="p", space_name="1", domains=[Domain("a", "", "shared")])
    )
    with pytest.raises(ValueError, match="领域未登记"):
        view.put_space(
            Space(
                space_id="s2", project_id="p", space_name="2", domains=[Domain("b", "", "shared")]
            )
        )
    assert view.get_space("s1").domains[0].name == "a"
    assert view.get_space("s2") is None
