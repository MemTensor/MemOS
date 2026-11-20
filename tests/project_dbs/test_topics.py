"""Contract tests for topic and entry reads and writes; run on every backend."""

import uuid

from datetime import datetime, timedelta, timezone

import pytest

from memos.project_dbs.exceptions import (
    DomainNotFoundError,
    EntryNotFoundError,
    SpaceClearedError,
    TopicNotFoundError,
    UpdateConflictError,
    VersionConflictError,
)
from memos.project_dbs.item import (
    ConflictItem,
    Decision,
    DecisionExtra,
    Domain,
    EntrySource,
    Experience,
    ExperienceExtra,
    HistoryItem,
    Source,
    Timeline,
    TimeRange,
    TopicChangeSet,
    TopicCreate,
    TopicFilter,
    TopicUpdate,
)


T0 = datetime(2026, 11, 1, tzinfo=timezone.utc)


def at(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


def now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def space(db):
    return db.create_space(
        f"project_{uuid.uuid4().hex}", "s", domains=[Domain(domain="开发"), Domain(domain="运维")]
    )


def decision(content="采用方案B", minute=10, **kw):
    return Decision(content=content, time=at(minute), user_ids=["user_a"], **kw)


def create(db, space, entries=(), sources=(), domain="开发", name="存储选型"):
    (result,) = db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accepted_at=now(),
            creates=[
                TopicCreate(
                    domain=domain,
                    topic_name=name,
                    topic_summary="摘要",
                    topic_description="描述",
                    entries=list(entries),
                    sources=list(sources),
                    embedding=[0.1] * 1024,
                )
            ],
        )
    )
    assert result.operation == "ADD"
    return result.topic_id


def update(db, space, **kw):
    return db.apply_changes(
        TopicChangeSet(space_id=space.id, accepted_at=now(), updates=[TopicUpdate(**kw)])
    )


# ---------- create and read ----------
def test_create_then_get_full_topic(db, space):
    full = decision(
        history=[
            HistoryItem(
                content="采用方案A",
                time=at(5),
                user_ids=["user_a"],
                reason="改用B",
                change_source=EntrySource(message_id="m7"),
            )
        ],
        conflicts=[ConflictItem(content="方案C", time=at(11), user_ids=["user_b"], seq=1)],
        extra=DecisionExtra(source=EntrySource(conversation_id="c1", quote="用B")),
    )
    topic_id = create(
        db,
        space,
        entries=[
            full,
            Experience(
                content="先压测", time=at(20), user_ids=[], extra=ExperienceExtra(use_count=2)
            ),
            Timeline(content="完成评审", time=at(30), user_ids=["user_b"]),
        ],
        sources=[
            Source(user_id="u1", conversation_id="c1"),
            Source(user_id="u1", conversation_id="c1"),
        ],
    )
    assert topic_id.startswith("topic_")
    (topic,) = db.get_topics([topic_id])
    assert (topic.space_id, topic.domain, topic.topic_name, topic.version) == (
        space.id,
        "开发",
        "存储选型",
        1,
    )
    assert topic.sources == [Source(user_id="u1", conversation_id="c1")]  # deduplicated
    (d,) = topic.decisions
    assert d.id and d.version == 1 and d.create_time and d.update_time
    assert d.history[0].change_source.message_id == "m7" and d.conflicts[0].seq == 1
    assert d.extra.source.quote == "用B"
    assert topic.experiences[0].extra.use_count == 2
    assert topic.timeline[0].content == "完成评审"


def test_get_topics_keeps_order_and_skips_unknown(db, space):
    a, b = create(db, space, name="a"), create(db, space, name="b")
    assert [t.id for t in db.get_topics([b, "topic_missing", a, b])] == [b, a]
    assert db.get_topics([]) == []


def test_create_with_unknown_domain_rolls_back(db, space):
    with pytest.raises(DomainNotFoundError):
        db.apply_changes(
            TopicChangeSet(
                space_id=space.id,
                accepted_at=now(),
                creates=[
                    TopicCreate(
                        domain="开发", topic_name="ok", topic_summary="s", topic_description="d"
                    ),
                    TopicCreate(
                        domain="不存在", topic_name="x", topic_summary="s", topic_description="d"
                    ),
                ],
            )
        )
    assert db.list_topics(space.id).total == 0


# ---------- update ----------
def test_update_fields_entries_and_sources(db, space):
    keep, replace, drop = decision("保留", 1), decision("旧结论", 2), decision("删除", 3)
    topic_id = create(db, space, entries=[keep, replace, drop], sources=[Source(user_id="u1")])
    (topic,) = db.get_topics([topic_id])
    by_content = {d.content: d for d in topic.decisions}

    results = update(
        db,
        space,
        topic_id=topic_id,
        expected_version=1,
        domain="运维",
        topic_summary="新摘要",
        upsert_entries=[
            decision("新结论", 4, id=by_content["旧结论"].id),
            Timeline(content="新进展", time=at(40), user_ids=[]),
        ],
        delete_entry_ids=[by_content["删除"].id],
        add_sources=[Source(user_id="u1"), Source(user_id="u2", agent_id="codex")],
    )
    assert [(r.topic_id, r.operation) for r in results] == [(topic_id, "UPDATE")]
    (topic,) = db.get_topics([topic_id])
    assert (topic.domain, topic.topic_summary, topic.topic_description, topic.version) == (
        "运维",
        "新摘要",
        "描述",
        2,
    )
    assert {d.content: d.version for d in topic.decisions} == {"保留": 1, "新结论": 2}
    assert [t.content for t in topic.timeline] == ["新进展"]
    assert topic.sources == [Source(user_id="u1"), Source(user_id="u2", agent_id="codex")]


def test_version_conflict_rolls_back_whole_batch(db, space):
    topic_id = create(db, space)
    update(db, space, topic_id=topic_id, expected_version=1, topic_summary="v2")
    with pytest.raises(VersionConflictError):
        db.apply_changes(
            TopicChangeSet(
                space_id=space.id,
                accepted_at=now(),
                creates=[
                    TopicCreate(
                        domain="开发", topic_name="new", topic_summary="s", topic_description="d"
                    )
                ],
                updates=[TopicUpdate(topic_id=topic_id, expected_version=1, topic_summary="stale")],
            )
        )
    assert db.list_topics(space.id).total == 1
    assert db.get_topics([topic_id])[0].topic_summary == "v2"


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        ({"topic_id": "topic_missing", "expected_version": 1}, TopicNotFoundError),
        ({"expected_version": 1, "domain": "不存在"}, DomainNotFoundError),
        ({"expected_version": 1, "upsert_entries": [decision(id="missing")]}, EntryNotFoundError),
    ],
)
def test_update_errors(db, space, kwargs, error):
    topic_id = create(db, space)
    with pytest.raises(error):
        update(db, space, **{"topic_id": topic_id, **kwargs})
    assert db.get_topics([topic_id])[0].version == 1


def test_update_cannot_touch_topic_of_another_space(db, space):
    other = db.create_space("p", "other", domains=[Domain(domain="开发")])
    foreign = create(db, other)
    with pytest.raises(TopicNotFoundError):
        update(db, space, topic_id=foreign, expected_version=1, topic_summary="x")


# ---------- clear and delete ----------
def test_clear_space_rejects_older_tasks(db, space):
    create(db, space)
    accepted = now()
    assert db.clear_space(space.id) == 1
    assert db.list_topics(space.id).total == 0
    cleared = db.list_spaces(space.project_id, [space.id])[0].cleared_at
    assert cleared is not None
    assert [d.domain for d in db.list_domains(space.id)]  # domains kept
    with pytest.raises(SpaceClearedError):
        db.apply_changes(
            TopicChangeSet(
                space_id=space.id,
                accepted_at=accepted,
                creates=[
                    TopicCreate(
                        domain="开发", topic_name="late", topic_summary="s", topic_description="d"
                    )
                ],
            )
        )
    db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accepted_at=cleared + timedelta(seconds=1),
            creates=[
                TopicCreate(
                    domain="开发", topic_name="fresh", topic_summary="s", topic_description="d"
                )
            ],
        )
    )
    assert db.list_topics(space.id).total == 1


def test_delete_topics_cascades_entries(db, space):
    a, b = create(db, space, entries=[decision()]), create(db, space)
    assert db.delete_topics([a, "topic_missing"]) == 1
    assert db.delete_topics([]) == 0
    assert [t.id for t in db.list_topics(space.id).items] == [b]
    assert db.list_entries(a, "decision").total == 0


# ---------- update_decision ----------
def test_update_decision_replaces_content_and_clears_conflicts(db, space):
    topic_id = create(
        db,
        space,
        entries=[
            decision(
                history=[HistoryItem(content="A", time=at(1), user_ids=[])],
                conflicts=[ConflictItem(content="C", time=at(2), user_ids=[])],
            )
        ],
    )
    (old,) = db.get_topics([topic_id])[0].decisions
    new = db.update_decision(old.id, old.update_time, "采用方案D", embedding=[0.2] * 1024)
    assert (new.id, new.content, new.conflicts, new.version) == (old.id, "采用方案D", [], 2)
    assert new.history == old.history and new.update_time > old.update_time
    with pytest.raises(UpdateConflictError):
        db.update_decision(old.id, old.update_time, "stale")


def test_update_decision_rejects_non_decision(db, space):
    topic_id = create(db, space, entries=[Timeline(content="t", time=at(1), user_ids=[])])
    (entry,) = db.get_topics([topic_id])[0].timeline
    with pytest.raises(UpdateConflictError):
        db.update_decision(entry.id, entry.update_time, "x")


# ---------- list_topics ----------
def test_list_topics_orders_pages_and_previews(db, space):
    first = create(db, space, name="first", entries=[decision(f"d{i}", i) for i in range(7)])
    second = create(
        db,
        space,
        name="second",
        entries=[
            decision("with history", 1, history=[HistoryItem(content="h", time=at(0), user_ids=[])])
        ],
    )
    page1 = db.list_topics(space.id, page=1, size=1)
    assert (page1.total, [t.id for t in page1.items]) == (2, [second])
    assert page1.items[0].decisions[0].history == []  # previews carry no history
    page2 = db.list_topics(space.id, page=2, size=1, preview_size=3)
    assert [t.id for t in page2.items] == [first]
    assert [d.content for d in page2.items[0].decisions] == ["d6", "d5", "d4"]
    assert db.list_topics(space.id, page=3, size=1).items == []


def test_list_topics_filters_are_or_of_and_groups(db, space):
    a = create(db, space, name="a")
    b = create(db, space, name="b")
    topics = {t.id: t for t in db.get_topics([a, b])}
    ta, tb = topics[a].update_time, topics[b].update_time
    assert ta < tb

    def ids(filters):
        return {t.id for t in db.list_topics(space.id, filters=filters).items}

    assert ids(None) == ids([]) == {a, b}
    assert ids([TopicFilter(update_time=TimeRange(gt=ta))]) == {b}
    assert ids([TopicFilter(create_time=TimeRange(lte=ta), update_time=TimeRange(gte=ta))]) == {a}
    assert ids(
        [TopicFilter(update_time=TimeRange(lt=ta)), TopicFilter(update_time=TimeRange(gte=tb))]
    ) == {b}
    assert ids([TopicFilter()]) == {a, b}
    assert ids([TopicFilter(update_time=TimeRange(gt=tb))]) == set()


# ---------- list_entries ----------
def test_list_entries_by_type_with_paging(db, space):
    topic_id = create(
        db,
        space,
        entries=[
            *[
                decision(f"d{i}", i, history=[HistoryItem(content="h", time=at(0), user_ids=[])])
                for i in range(3)
            ],
            Timeline(content="t", time=at(50), user_ids=[]),
        ],
    )
    page = db.list_entries(topic_id, "decision", page=1, size=2)
    assert page.total == 3 and [d.content for d in page.items] == ["d2", "d1"]
    assert page.items[0].history[0].content == "h"
    assert [d.content for d in db.list_entries(topic_id, "decision", page=2, size=2).items] == [
        "d0"
    ]
    assert db.list_entries(topic_id, "timeline").total == 1
    assert db.list_entries(topic_id, "experience").total == 0


def test_missing_space_and_unknown_ids(db):
    from memos.project_dbs.exceptions import SpaceNotFoundError

    with pytest.raises(SpaceNotFoundError):
        db.apply_changes(TopicChangeSet(space_id="missing", accepted_at=now()))
    with pytest.raises(SpaceNotFoundError):
        db.clear_space("missing")
    assert db.get_topics(["topic_missing"]) == []
    assert db.list_topics("missing").total == 0


# ---------- edge cases ----------
def test_anchors_replaced_only_when_given(db, space):
    topic_id = create(db, space)
    update(db, space, topic_id=topic_id, expected_version=1, anchors=[{"path": "a.py"}])
    update(db, space, topic_id=topic_id, expected_version=2, topic_summary="x")
    assert db.get_topics([topic_id])[0].anchors == [{"path": "a.py"}]
    update(db, space, topic_id=topic_id, expected_version=3, anchors=[])
    assert db.get_topics([topic_id])[0].anchors == []


def test_entries_of_another_topic_are_untouchable(db, space):
    a = create(db, space, entries=[decision("a")])
    b = create(db, space, entries=[decision("b")])
    (b_decision,) = db.get_topics([b])[0].decisions
    update(db, space, topic_id=a, expected_version=1, delete_entry_ids=[b_decision.id])
    assert db.list_entries(b, "decision").total == 1  # foreign id ignored
    with pytest.raises(EntryNotFoundError):
        update(
            db,
            space,
            topic_id=a,
            expected_version=2,
            upsert_entries=[decision("x", id=b_decision.id)],
        )


def test_many_entries_in_one_create(db, space):
    topic_id = create(db, space, entries=[decision(f"d{i}", i) for i in range(150)])
    assert db.list_entries(topic_id, "decision", size=200).total == 150


def test_accepted_at_equal_to_cleared_at_is_rejected(db, space):
    db.clear_space(space.id)
    cleared = db.list_spaces(space.project_id, [space.id])[0].cleared_at
    with pytest.raises(SpaceClearedError):
        db.apply_changes(TopicChangeSet(space_id=space.id, accepted_at=cleared))


def test_upsert_bumps_entry_version_and_update_decision_keeps_topic_version(db, space):
    topic_id = create(db, space, entries=[decision("v1")])
    (d,) = db.get_topics([topic_id])[0].decisions
    update(
        db, space, topic_id=topic_id, expected_version=1, upsert_entries=[decision("v2", id=d.id)]
    )
    (d2,) = db.get_topics([topic_id])[0].decisions
    assert (d2.version, d2.create_time) == (2, d.create_time) and d2.update_time > d.update_time
    db.update_decision(d2.id, d2.update_time, "v3")
    topic = db.get_topics([topic_id])[0]
    assert topic.version == 2 and topic.decisions[0].content == "v3"


def test_preview_size_zero_and_invalid_paging(db, space):
    create(db, space, entries=[decision()])
    (topic,) = db.list_topics(space.id, preview_size=0).items
    assert topic.decisions == []
    with pytest.raises(ValueError):
        db.list_topics(space.id, page=0)
    with pytest.raises(ValueError):
        db.list_entries("topic_x", "decision", size=0)


def test_naive_datetimes_are_rejected(db, space):
    from pydantic import ValidationError

    naive = datetime(2026, 11, 1)
    with pytest.raises(ValidationError):
        TopicChangeSet(space_id=space.id, accepted_at=naive)
    with pytest.raises(ValidationError):
        TimeRange(gt=naive)
    with pytest.raises(ValidationError):
        Decision(content="x", time=naive, user_ids=[])
    with pytest.raises(ValueError):
        db.update_decision("d", naive, "x")
