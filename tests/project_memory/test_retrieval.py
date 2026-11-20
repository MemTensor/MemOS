from memos.project_memory.index import split_turn, terms


def test_long_turn_round_trips_without_changing_the_shared_text():
    original = ("共享原文\n" * 550) + "结尾"
    chunks = list(split_turn(original))
    assert "".join(chunks) == original
    assert all(0 < len(chunk) <= 2000 for chunk in chunks)


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


def test_cacheable_turn_requires_explicit_confirmation():
    from memos.project_memory.index import Turn

    assert Turn.model_fields["cache_policy"].default == "live"
