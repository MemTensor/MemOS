from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from memos.project_memory.add_acceptance import AcceptanceSettings, AddAcceptance, AddRequestError
from tests.project_memory import test_add_store


add_store = test_add_store.add_store


def _spaces(store, *names):
    with store.transaction() as cursor:
        for name in names:
            cursor.execute(
                "INSERT INTO spaces (id, project_id, space_name) VALUES (%s, %s, %s)",
                (name, "project-a", name),
            )
            cursor.execute(
                "INSERT INTO domains (id, space_id, domain) VALUES (%s, %s, 'development')",
                (f"{name}-domain", name),
            )


def _request(task_id, message_id, *, spaces=None, conversation_id="chat", text="Ship the text"):
    return SimpleNamespace(
        project_id="project-a",
        task_id=task_id,
        user_id="member-a",
        space_ids=spaces or ["space-a"],
        conversation_id=conversation_id,
        messages=[{"role": "user", "message_id": message_id, "content": text}],
    )


def test_multispace_acceptance_dedup_status_and_reopen(add_store):
    _spaces(add_store, "space-a", "space-b")
    clock = [datetime(2026, 11, 19, 0, 0, tzinfo=timezone.utc)]
    accept = AddAcceptance(add_store, clock=lambda: clock[0])
    first = _request("task-a", "message-a", spaces=["space-a", "space-b"])
    assert accept.accept(first).closed_episode_ids == []
    assert (
        accept.status("task-a", "member-a")["memory_views"]["project"]["open_episode_messages"] == 1
    )
    assert accept.status("task-a", "other-member") is None

    assert (
        accept.accept(_request("replay", "message-a", spaces=first.space_ids)).task_id == "task-a"
    )
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT COUNT(*) AS count FROM messages")
        assert cursor.fetchone()["count"] == 1
        cursor.execute("SELECT COUNT(*) AS count FROM episodes")
        assert cursor.fetchone()["count"] == 2
        cursor.execute("SELECT msg_seq FROM messages")
        assert cursor.fetchone()["msg_seq"] == 1

    clock[0] += timedelta(minutes=15)
    due = accept.close_due()
    assert len(due) == 2
    assert accept.close_due() == []
    assert accept.status("task-a", "member-a")["status"] == "in_progress"

    accept.accept(_request("task-b", "message-b"))
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute(
            "SELECT episode_id FROM add_jobs WHERE space_id = 'space-a' AND stage = 'episode_open'"
        )
        episode_id = cursor.fetchone()["episode_id"]
    reopened = add_store.load_episode(episode_id)
    assert reopened["owner_task_id"] == "task-b"
    assert reopened["previous"]["space_id"] == "space-a"
    assert reopened["previous"]["id"] in due
    assert [m["origin_task_id"] for m in reopened["messages"]] == ["task-b"]
    assert [m["origin_task_id"] for m in reopened["previous"]["messages"]] == ["task-a"]
    assert (reopened["message_seq_start"], reopened["previous"]["message_seq_end"]) == (2, 1)


def test_conflict_rolls_back_and_no_conversation_closes(add_store):
    _spaces(add_store, "space-a", "space-b")
    accept = AddAcceptance(add_store)
    request = _request("task-a", "message-a", conversation_id=None)
    receipt = accept.accept(request)
    assert len(receipt.closed_episode_ids) == 1
    assert (
        add_store.load_episode(receipt.closed_episode_ids[0])["close_reason"] == "no_conversation"
    )
    request.messages[0]["content"] = "Changed input"
    with pytest.raises(AddRequestError, match="message-a") as error:
        accept.accept(request)
    assert error.value.reason == "MESSAGE_ID_CONFLICT"
    with pytest.raises(AddRequestError) as missing:
        accept.accept(_request("task-b", "message-b", spaces=["space-a", "missing"]))
    assert missing.value.reason == "SPACE_NOT_FOUND"
    assert accept.status("task-b", "member-a") is None


def test_concurrent_full_replay_uses_original_task(add_store):
    _spaces(add_store, "space-a", "space-b")
    accept = AddAcceptance(add_store)
    concurrent_requests = [
        _request(name, "message-a", spaces=["space-b", "space-a"]) for name in ("task-a", "task-b")
    ]
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(accept.accept, concurrent_requests))
    assert len({result.task_id for result in results}) == 1
    assert sum(result.duplicate for result in results) == 1


def test_replay_uses_original_task_after_a_domain_is_added(add_store):
    _spaces(add_store, "space-a")
    accept = AddAcceptance(add_store)
    assert accept.accept(_request("original", "message-a")).task_id == "original"
    with add_store.transaction() as cursor:
        cursor.execute(
            "INSERT INTO domains (id, space_id, domain) VALUES ('new-domain', 'space-a', 'new-work')"
        )
    replay = accept.accept(_request("different-id", "message-a"))
    assert replay.task_id == "original"
    assert replay.duplicate


def test_closed_at_turn_count_and_mixed_task_replay_rejected(add_store):
    _spaces(add_store, "space-a")
    accept = AddAcceptance(add_store, AcceptanceSettings(max_turns=2))
    first = _request("task-a", "message-a")
    second = _request("task-b", "message-b", text="Agree with that decision")
    assert accept.accept(first).closed_episode_ids == []
    closed = accept.accept(second).closed_episode_ids
    episode = add_store.load_episode(closed[0])
    assert episode["close_reason"] == "turn_count"
    assert [turn["task_id"] for turn in episode["turns"]] == ["task-a", "task-b"]
    assert episode["task_ranges"] == {"task-a": [1, 1], "task-b": [2, 2]}
    assert episode["task_ids"] == ["task-a", "task-b"]
    replay = _request("task-c", "unused")
    replay.messages = first.messages + second.messages
    with pytest.raises(AddRequestError) as error:
        accept.accept(replay)
    assert error.value.reason == "TASK_REPLAY_CONFLICT"


def test_preserves_assistant_tool_link_and_full_original_output(add_store):
    _spaces(add_store, "space-a")
    accept = AddAcceptance(add_store)
    request = _request("task-a", "message-a", conversation_id=None)
    raw_output = "output line\n" * 20_000
    request.messages.extend(
        [
            {
                "role": "assistant",
                "content": "<memos_context>hidden</memos_context>调用工具",
                "message_id": "call-message",
                "tool_calls": [
                    {
                        "id": "call",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path":"x.py"}'},
                    }
                ],
            },
            {
                "role": "tool",
                "message_id": "output-message",
                "tool_call_id": "call",
                "content": raw_output,
            },
        ]
    )
    episode = add_store.load_episode(accept.accept(request).closed_episode_ids[0])
    _, call, output = episode["messages"]
    assert call["content"] == "调用工具"
    assert not call["tool_calls"]
    assert output["message_id"] == "output-message"
    assert output["tool_calls"] == [
        {
            "id": output["tool_call_id"],
            "type": "function",
            "function": {"name": "read_file", "arguments": '{"path":"x.py"}'},
        }
    ]
    assert output["content"] == raw_output


def test_keeps_system_source_without_turn_or_anchor_authority(add_store):
    from memos.project_memory.add_extraction import extract_episode

    _spaces(add_store, "space-a")
    accept = AddAcceptance(add_store)
    request = _request("task-a", "message-a", conversation_id=None)
    system = {
        "role": "system",
        "message_id": "system",
        "content": "new task. Reference: src/internal.py",
    }
    request.messages.insert(0, system)
    episode = add_store.load_episode(accept.accept(request).closed_episode_ids[0])
    assert [row["role"] for row in episode["messages"]] == ["system", "user"]
    assert [row["turn_id"] for row in episode["messages"]] == ["message-a", "message-a"]
    assert episode["turns"][0]["turn_id"] == "message-a"
    assert episode["messages"][0]["role_id"] is None
    # Anchors come from extraction, which never reads the system context.
    writer = SimpleNamespace(write=lambda *_args: {"episode_summary": "", "drafts": []})
    result = extract_episode(writer, episode, episode["messages"])
    assert result["anchors"] == []
    request.task_id = "system-only"
    request.messages = [system]
    with pytest.raises(AddRequestError) as error:
        accept.accept(request)
    assert error.value.reason == "INVALID_PARAMS"


def test_project_comes_from_the_spaces(add_store):
    """project_id is optional: the write lands in the Spaces' project; a named project must match."""
    _spaces(add_store, "space-a")
    with add_store.transaction() as cursor:
        cursor.execute(
            "INSERT INTO spaces (id, project_id, space_name) VALUES ('space-x', 'project-x', 'X')"
        )
        cursor.execute(
            "INSERT INTO domains (id, space_id, domain) VALUES ('x-domain', 'space-x', 'development')"
        )
    accept = AddAcceptance(add_store)

    with pytest.raises(AddRequestError) as error:
        accept.accept(_request("task-a", "message-a", spaces=["space-a", "space-x"]))
    assert error.value.reason == "SPACE_NOT_FOUND"
    with pytest.raises(AddRequestError) as error:
        accept.accept(_request("task-a", "message-a", spaces=["space-x"]))
    assert error.value.reason == "SPACE_NOT_FOUND"
    mixed = _request("task-a", "message-a", spaces=["space-a", "space-x"])
    mixed.project_id = None
    with pytest.raises(AddRequestError) as error:
        accept.accept(mixed)
    assert error.value.reason == "INVALID_PARAMS"

    unnamed = _request("task-x", "message-a", spaces=["space-x"])
    unnamed.project_id = None
    accept.accept(unnamed)
    accept.accept(_request("task-a", "message-a"))
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT project_id, space_id FROM add_jobs ORDER BY space_id")
        assert [(row["project_id"], row["space_id"]) for row in cursor.fetchall()] == [
            ("project-a", "space-a"),
            ("project-x", "space-x"),
        ]
        cursor.execute("SELECT project_id FROM messages ORDER BY project_id")
        assert [row["project_id"] for row in cursor.fetchall()] == ["project-a", "project-x"]


def test_closes_on_budgets_not_on_phrases(add_store):
    """A task-switch phrase no longer closes the Episode; budgets and the domain set do."""
    _spaces(add_store, "space-a")
    with add_store.transaction() as cursor:
        cursor.execute(
            "INSERT INTO domains (id, space_id, domain) VALUES ('ops', 'space-a', 'operations')"
        )
    accept = AddAcceptance(add_store, AcceptanceSettings(max_turns=3))
    assert accept.accept(_request("t1", "m1")).closed_episode_ids == []
    assert accept.accept(_request("t2", "m2", text="换个任务，看看发布")).closed_episode_ids == []
    request = _request("t3", "m3")
    request.domains = ["operations"]
    (closed,) = accept.accept(request).closed_episode_ids
    episode = add_store.load_episode(closed)
    assert episode["close_reason"] == "domain_change"
    assert [m["message_id"] for m in episode["messages"]] == ["m1", "m2"]
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT domains FROM add_jobs WHERE stage = 'episode_open'")
        assert cursor.fetchone()["domains"] == ["operations"]


def test_interleaved_messages_of_another_space_split_the_range(add_store):
    _spaces(add_store, "space-a", "space-b")
    accept = AddAcceptance(add_store)
    accept.accept(_request("t1", "m1", spaces=["space-a"]))
    accept.accept(_request("t2", "m2", spaces=["space-b"]))
    (closed,) = accept.accept(_request("t3", "m3", spaces=["space-a"])).closed_episode_ids
    first = add_store.load_episode(closed)
    assert first["close_reason"] == "interleaved"
    assert (first["message_seq_start"], first["message_seq_end"]) == (1, 1)
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute(
            """SELECT e.message_seq_start, e.message_seq_end, e.previous_episode_id
               FROM add_jobs j JOIN episodes e ON e.id = j.episode_id
               WHERE j.space_id = 'space-a' AND j.stage = 'episode_open'"""
        )
        assert cursor.fetchone() == {
            "message_seq_start": 3,
            "message_seq_end": 3,
            "previous_episode_id": closed,
        }


def test_replayed_message_keeps_its_seq_and_agent_is_text(add_store):
    _spaces(add_store, "space-a")
    accept = AddAcceptance(add_store)
    request = _request("t1", "m1")
    request.agent_id = ["codex", "helper"]
    accept.accept(request)
    accept.accept(_request("t2", "m2"))
    replay = _request("t3", "m1")
    replay.agent_id = ["codex", "helper"]
    assert accept.accept(replay).duplicate
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT message_id, msg_seq, agent_id FROM messages ORDER BY msg_seq")
        assert cursor.fetchall() == [
            {"message_id": "m1", "msg_seq": 1, "agent_id": "codex"},
            {"message_id": "m2", "msg_seq": 2, "agent_id": None},
        ]
