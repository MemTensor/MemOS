import pytest

from evaluation.frontiermemory_topic.dataset import SourceMessage
from evaluation.frontiermemory_topic.expand import build_expansion


A = "https://frontiermemory.com/traces/example/a/"
B = "https://frontiermemory.com/traces/example/b/"


def test_expansion_preserves_source_order_and_separates_gold_from_messages(monkeypatch):
    def trace(html):
        return {
            ordinal: [
                SourceMessage(ordinal, "user", f"Question {ordinal}"),
                SourceMessage(ordinal + 1, "assistant", f"Answer {html.decode()} {ordinal}"),
            ]
            for ordinal in (1, 6)
        }

    monkeypatch.setattr("evaluation.frontiermemory_topic.expand.parse_trace", trace)
    groups = [
        {
            "source_task": "one-task",
            "gold_work": label,
            "why": "Paired requests have the same scope.",
            "turns": [{"trace_url": url, "source_ordinal": ordinal} for url in (A, B)],
        }
        for ordinal, label in ((6, "later"), (1, "earlier"))
    ]
    manifest = build_expansion(groups, {A: b"a", B: b"b"})
    turns = manifest["turns"]

    assert [row["wave"] for row in turns] == [1, 1, 2, 2]
    assert [row["gold_work"] for row in turns] == ["earlier", "earlier", "later", "later"]
    assert len({row["user_id"] for row in turns}) == 2
    assert all(row["turn_id"] == row["messages"][0]["message_id"] for row in turns)
    assert set(turns[0]["messages"][0]) == {"message_id", "role", "content"}
    assert manifest["work_groups"]["later"]["repeat_prompt"] is True

    with pytest.raises(ValueError, match="duplicate dialogue"):
        build_expansion(groups, {A: b"a", B: b"a"})
