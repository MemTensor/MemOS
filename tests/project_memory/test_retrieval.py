from memos.project_memory.index import terms


def test_chinese_and_error_codes_are_searchable():
    indexed = set(terms("写入失败，错误码 HTTP_409"))
    assert {"写入", "失败", "错误", "误码", "http_409"} <= indexed


def test_mixed_ranks_favor_current_session_then_distinct_content():
    from memos.project_memory.retrieval import mix
    from memos.project_memory.store import Hit

    lanes = [
        [Hit("topic_detail_list", {"id": "a", "topic_summary": "SQLite migration"}, 1, True)],
        [
            Hit("memory_detail_list", {"id": "b", "memory": "SQLite migration"}, 1),
            Hit("memory_detail_list", {"id": "c", "memory": "rollback procedure"}, 0.8),
        ],
    ]
    selected, truncated = mix(lanes, 2)
    assert [hit.data["id"] for hit in selected] == ["a", "c"] and truncated
    assert selected[0].data["relativity"] >= selected[1].data["relativity"]


def test_time_budgets_scale_from_the_environment(monkeypatch):
    from memos.project_memory.views import budget

    monkeypatch.delenv("MEMOS_PROJECT_RETRIEVAL_TIME_SCALE", raising=False)
    assert budget(0.46) == 0.46
    monkeypatch.setenv("MEMOS_PROJECT_RETRIEVAL_TIME_SCALE", "4")
    assert budget(0.10) == 0.4


def test_skeleton_keeps_message_ids_and_omits_tool_output():
    from memos.project_memory.turns import turn_skeletons

    messages = [
        {"message_id": "u", "role": "user", "content": "inspect build"},
        {
            "message_id": "a",
            "role": "assistant",
            "content": "checking",
            "tool_calls": [{"function": {"name": "build", "arguments": "verbose args"}}],
        },
        {"message_id": "t", "role": "tool", "content": "verbose output"},
        {"message_id": "r", "role": "assistant", "content": "all tests passed"},
    ]
    (turn,) = turn_skeletons([{**m, "turn_id": "add-turn-id"} for m in messages])
    assert turn.turn_id == "add-turn-id"
    assert turn.msg_ids == ["u", "a", "t", "r"]
    assert all(s in turn.content for s in ("inspect build", "build", "all tests passed"))
    assert "verbose" not in turn.content and "checking" not in turn.content
