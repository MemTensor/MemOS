"""Playground recall must keep memories from every searched cube."""

from memos.api.handlers.chat_handler import ChatHandler


def test_playground_recall_keeps_memories_from_later_cubes():
    search_data = {
        "text_mem": [
            {"cube_id": "knowledge-base", "memories": []},
            {
                "cube_id": "personal",
                "memories": [{"id": "mem-1", "memory": "use event_id as the idempotency key"}],
            },
        ]
    }

    memories = ChatHandler._memories_from_cube_results(search_data)

    assert [item["id"] for item in memories] == ["mem-1"]


def test_playground_recall_returns_empty_when_search_data_missing():
    assert ChatHandler._memories_from_cube_results(None) == []
    assert ChatHandler._memories_from_cube_results({}) == []
