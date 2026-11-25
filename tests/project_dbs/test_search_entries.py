"""PostgreSQL-only checks of search_entries_by_embedding / _fulltext."""

from datetime import datetime, timedelta, timezone

import pytest

from memos.project_dbs.item import (
    ConflictCard,
    Decision,
    DecisionCard,
    Domain,
    EntryStatus,
    Experience,
    Timeline,
    TimeRange,
    TopicChangeSet,
    TopicCreate,
    TopicFilter,
)
from tests.project_dbs.conftest import DIM


NOW = datetime.now(timezone.utc)
CARD = {"task_intent": "rollback", "problem": "p", "principle": "q"}


def vec(*head: float) -> list[float]:
    return [*head, *([0.0] * (DIM - len(head)))]


Q = vec(1.0)  # the query vector


@pytest.fixture
def world(pg_db):
    """Three topics in one space plus a foreign space with a perfect match."""
    domains = [Domain(domain="dev"), Domain(domain="ops")]
    space = pg_db.create_space("search-entries", "s", domains=domains)
    other = pg_db.create_space("search-entries", "o", domains=domains)

    def create(space_id, name, entries, domain="dev", updated=NOW):
        (result,) = pg_db.apply_changes(
            TopicChangeSet(
                space_id=space_id,
                accept_time=NOW,
                creates=[
                    TopicCreate(
                        domain=domain,
                        topic_name=name,
                        topic_summary="s",
                        topic_description="d",
                        create_time=updated,
                        update_time=updated,
                        entries=entries,
                    )
                ],
            )
        )
        return result.topic_id

    def decision(content, embedding, **kw):
        return Decision(content=content, chat_time=NOW, user_ids=[], embedding=embedding, **kw)

    a = create(
        space.id,
        "a",
        [
            decision(
                "use plan B",
                vec(0.0, 1.0),
                history=[
                    DecisionCard(
                        content="use rollback plan A",
                        chat_time=NOW,
                        user_ids=[],
                        embedding=Q,
                    )
                ],
            ),
            decision("ship weekly", vec(0.8, 0.6)),
            decision("ship daily", vec(0.6, 0.8)),
        ],
    )
    b = create(
        space.id,
        "b",
        [
            decision(
                "keep the cache",
                vec(0.0, 0.0, 1.0),
                conflicts=[
                    ConflictCard(
                        content="drop the cache before rollback",
                        chat_time=NOW,
                        user_ids=[],
                        embedding=vec(0.9, 0.0, 0.1),
                    )
                ],
            ),
            Timeline(
                content="rollback drill done", chat_time=NOW, user_ids=[], embedding=vec(0.5, 0.5)
            ),
        ],
    )
    retired = create(
        space.id,
        "retired",
        [Experience(content="", chat_time=NOW, user_ids=[], extra={"card": CARD}, embedding=Q)],
    )
    ops = create(space.id, "ops", [decision("rollback ops", Q)], domain="ops")
    old = create(space.id, "old", [decision("rollback old", Q)], updated=NOW - timedelta(days=30))
    create(other.id, "foreign", [decision("rollback foreign", Q)])
    with pg_db._tx() as cur:
        cur.execute(
            "UPDATE project_memory.project_entries SET status = 1 WHERE topic_id = %s", (retired,)
        )
    yield {"space": space, "a": a, "b": b, "ops": ops, "old": old}
    pg_db.delete_space(space.id)
    pg_db.delete_space(other.id)


RECENT = [TopicFilter(update_time=TimeRange(gte=NOW - timedelta(days=1)))]


def test_embedding_hits_fold_children_and_group_by_topic(pg_db, world):
    hits = pg_db.search_entries_by_embedding(
        [world["space"].id], Q, domains=["dev"], filters=RECENT, per_topic=2
    )
    got = [(h.entry.topic_id, h.entry.content, round(h.score, 3)) for h in hits]
    assert got == [
        (world["a"], "use plan B", 1.0),  # its history row matched exactly
        (world["a"], "ship weekly", 0.8),
        (world["b"], "keep the cache", 0.994),  # its conflict row matched
        (world["b"], "rollback drill done", 0.707),
    ]
    first = hits[0].entry
    assert first.status == EntryStatus.ACTIVE and first.space_id == world["space"].id
    assert [h.content for h in first.history] == ["use rollback plan A"]
    assert [c.content for c in hits[2].entry.conflicts] == ["drop the cache before rollback"]
    top1 = pg_db.search_entries_by_embedding([world["space"].id], Q, domains=["dev"],
                                             filters=RECENT, top_k=1)  # fmt: skip
    assert {h.entry.topic_id for h in top1} == {world["a"]} and len(top1) == 3


def test_embedding_scope_filters(pg_db, world):
    space_id = world["space"].id
    topics = {h.entry.topic_id for h in pg_db.search_entries_by_embedding([space_id], Q)}
    assert topics == {world["a"], world["b"], world["ops"], world["old"]}  # retired skipped
    ops = pg_db.search_entries_by_embedding([space_id], Q, domains=["ops"])
    assert [h.entry.content for h in ops] == ["rollback ops"]
    assert pg_db.search_entries_by_embedding([], Q) == []
    assert pg_db.search_entries_by_embedding([space_id], Q, top_k=0) == []
    assert pg_db.search_entries_by_embedding([space_id], Q, per_topic=0) == []


def test_fulltext_matches_any_term_and_folds_children(pg_db, world):
    space_id = world["space"].id
    hits = pg_db.search_entries_by_fulltext(
        [space_id], "rollback nothing", domains=["dev"], filters=RECENT
    )
    by_topic: dict[str, list] = {}
    for hit in hits:
        by_topic.setdefault(hit.entry.topic_id, []).append(hit)
    assert list(by_topic) == sorted(by_topic, key=lambda t: -max(h.score for h in by_topic[t]))
    assert [h.entry.content for h in by_topic[world["a"]]] == ["use plan B"]  # history row
    assert {h.entry.content for h in by_topic[world["b"]]} == {  # conflict row and timeline
        "keep the cache",
        "rollback drill done",
    }
    for topic_hits in by_topic.values():
        scores = [h.score for h in topic_hits]
        assert scores == sorted(scores, reverse=True)
    assert all(h.score > 0 for h in hits)
    assert pg_db.search_entries_by_fulltext([space_id], "   ") == []
    assert pg_db.search_entries_by_fulltext([space_id], "nothing") == []
