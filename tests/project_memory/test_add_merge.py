from copy import deepcopy

from memos.project_memory.add_merge import prepare_merge, rebase_append_only, rewrite_metadata


class Writer:
    def __init__(self, output=None):
        self.output = output or {}
        self.calls = []

    def write(self, scope, *_args):
        self.calls.append(scope)
        return self.output.get(scope, {})


def plan_for(draft, topic=None):
    topic = topic or {
        "id": "topic",
        "space_id": "space",
        "domain_id": "domain",
        "version": 1,
        "topic_name": "Connection pools",
        "topic_summary": "",
        "topic_description": "",
    }
    episode = {
        "id": "episode",
        "space_id": "space",
        "conversation_id": "session",
        "drafts": [
            {
                "draft_id": "draft",
                "origin": "member",
                "chat_time": "2026-11-19T11:00:00+08:00",
                "authors": ["user"],
                "author_name": "User",
                "quote": "池大小设为 16",
                "source_refs": [
                    {"message_id": "message", "source_path": "/content", "start": 0, "end": 9}
                ],
                **draft,
            }
        ],
    }
    return {
        "episode_id": "episode",
        "space_id": "space",
        "assignments": [{"topic": topic, "episodes": [episode]}],
        "staging": None,
        "staged_updates": [],
        "formation": None,
        "warnings": [],
    }


def test_existing_decision_rewrite_retains_history_and_does_not_mutate_snapshot():
    initial = {
        "id": "same-decision",
        "content": "池大小设为 8",
        "time": "2026-11-19T01:00:00Z",
        "user_ids": ["user"],
        "source": {},
        "history": [],
        "conflicts": [],
    }
    data = plan_for({"kind": "decision", "content": "池大小设为 16"})
    data["assignments"][0]["topic"]["decisions"] = [initial]
    frozen = deepcopy(data)
    writer = Writer(
        {"dec.update": {"results": [{"n": 1, "decision_id": "same-decision", "action": "rewrite"}]}}
    )
    change = prepare_merge(writer, data)
    proposed = change["topics"][0]["topic"]
    assert proposed["decisions"][0]["content"] == "池大小设为 16"
    assert proposed["decisions"][0]["history"][0]["content"] == "池大小设为 8"
    assert proposed["decisions"][0]["source"]["message_id"] == "message"
    assert change["kind"] == "modify"
    assert data == frozen
    assert writer.calls == ["dec.update"]


def test_append_rebase_keeps_concurrent_entries_and_rewrites_metadata():
    change = prepare_merge(Writer(), plan_for({"kind": "timeline", "content": "池大小设为 16"}))
    assert change["kind"] == "append"
    base = change["topics"][0]["topic"]
    concurrent = {
        **base,
        "version": 2,
        "timeline": [{"id": "another", "content": "Ready for release"}],
    }
    rebased = rebase_append_only(change, [concurrent])
    assert rebased["topics"][0]["expected_version"] == 2
    items = rebased["topics"][0]["topic"]["timeline"]
    assert len(items) == 2 and items[0]["id"] == "another"
    writer = Writer(
        {"episode.metadata": {"summary": "已发布 99 台机器", "description": "后续扩大部署"}}
    )
    ready = rewrite_metadata(writer, rebased)
    assert writer.calls == ["episode.metadata", "episode.metadata"]
    proposed = ready["topics"][0]["topic"]
    assert "99" not in proposed["topic_summary"]
    assert "后续" not in proposed["topic_description"]


def test_m05_adds_experience_from_draft_with_evidence():
    draft = {
        "kind": "experience",
        "content": "池大小设为 16",
        "card": {"task_intent": "调整池", "principle": "池大小设为 16"},
    }
    writer = Writer()
    change = prepare_merge(writer, plan_for(draft))
    (experience,) = change["topics"][0]["topic"]["experiences"]
    assert experience["card"]["principle"] == "池大小设为 16"
    assert experience["sources"][0]["message_id"] == "message"
    assert experience["user_ids"] == ["user"]
    assert change["kind"] == "append"
    assert not writer.calls
