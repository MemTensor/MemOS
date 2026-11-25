"""Contract tests for topic and entry reads and writes; run on every backend."""

import re
import uuid

from datetime import datetime, timedelta, timezone

import pytest

from memos.project_dbs.exceptions import (
    DomainNotFoundError,
    EntryNotFoundError,
    SpaceClearedError,
    SpaceNotFoundError,
    TopicNotFoundError,
    UpdateConflictError,
    VersionConflictError,
)
from memos.project_dbs.item import (
    ConflictCard,
    Decision,
    DecisionCard,
    DecisionExtra,
    Domain,
    EntrySource,
    EntryStatus,
    Experience,
    ExperienceExtra,
    Source,
    Timeline,
    TimeRange,
    TopicChangeSet,
    TopicCreate,
    TopicFilter,
    TopicUpdate,
)
from tests.project_dbs.conftest import DIM


T0 = datetime(2026, 11, 1, tzinfo=timezone.utc)
CARD = {"task_intent": "导出", "problem": "丢行", "principle": "先读代码"}


def at(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


def now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def space(db):
    return db.create_space(
        f"project_{uuid.uuid4().hex}", "s", domains=[Domain(domain="开发"), Domain(domain="运维")]
    )


def decision(content="采用方案B", minute=10, users=("user_a",), **kw):
    return Decision(content=content, chat_time=at(minute), user_ids=list(users), **kw)


def experience(minute=20, status="candidate", confidence=0.5, **card):
    return Experience(
        content="ignored",
        chat_time=at(minute),
        user_ids=[],
        extra=ExperienceExtra(card={**CARD, **card}, exp_status=status, confidence=confidence),
    )


def timeline(content="完成评审", minute=30):
    return Timeline(content=content, chat_time=at(minute), user_ids=[])


def topic_create(entries=(), sources=(), domain="开发", name="存储选型", updated=60, **kw):
    return TopicCreate(
        domain=domain,
        topic_name=name,
        topic_summary="摘要",
        topic_description="描述",
        entries=list(entries),
        sources=list(sources),
        create_time=at(0),
        update_time=at(updated),
        embedding=[0.1] * DIM,
        **kw,
    )


def create(db, space, entries=(), sources=(), **kw):
    (result,) = db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accept_time=now(),
            creates=[topic_create(entries, sources, **kw)],
        )
    )
    assert result.operation == "ADD"
    return result.topic_id


def update(db, space, **kw):
    return db.apply_changes(
        TopicChangeSet(space_id=space.id, accept_time=now(), updates=[TopicUpdate(**kw)])
    )


def detail(db, topic_id):
    (topic,) = db.get_topics_detail([topic_id])
    return topic


# ---------- create and read ----------
def test_create_then_get_full_topic(db, space):
    full = decision(
        history=[
            DecisionCard(
                content="采用方案A",
                chat_time=at(5),
                user_ids=["user_a"],
                reason="改用B",
                change_source=EntrySource(message_id="m7"),
            )
        ],
        conflicts=[ConflictCard(content="方案C", chat_time=at(11), user_ids=["user_b"])],
        extra=DecisionExtra(sources=[EntrySource(conversation_id="c1", quote="用B")]),
    )
    topic_id = create(
        db,
        space,
        entries=[full, experience(), timeline()],
        sources=[
            Source(user_id=["u1"], conversation_id="c1"),
            Source(user_id=["u2"], conversation_id="c1"),  # same conversation: users merge
            Source(user_id=["u1"], agent_id="codex"),
            Source(user_id=["u1"], agent_id="codex"),  # duplicate
        ],
    )
    assert re.fullmatch(r"topic_[0-9a-f]{32}", topic_id)
    topic = detail(db, topic_id)
    assert (topic.space_id, topic.domain, topic.topic_name, topic.version) == (
        space.id,
        "开发",
        "存储选型",
        1,
    )
    assert (topic.create_time, topic.update_time) == (at(0), at(60))  # chat times as given
    assert topic.sources == [
        Source(user_id=["u1", "u2"], conversation_id="c1"),
        Source(user_id=["u1"], agent_id="codex"),
    ]
    (d,) = topic.decisions
    assert d.id and d.version == 1 and d.create_time and d.update_time
    assert (d.topic_id, d.space_id, d.status) == (topic_id, space.id, EntryStatus.ACTIVE)
    (h,) = d.history
    assert h.id and h.id != d.id and h.reason == "改用B" and h.change_source.message_id == "m7"
    (c,) = d.conflicts
    assert c.id and (c.content, c.user_ids, c.chat_time) == ("方案C", ["user_b"], at(11))
    assert d.extra.sources[0].quote == "用B"
    (e,) = topic.experiences
    assert e.content == "导出｜丢行｜先读代码"
    assert topic.timeline[0].content == "完成评审"


def test_get_topics_detail_keeps_order_and_skips_unknown(db, space):
    a = create(db, space, name="a", entries=[decision()])
    b = create(db, space, name="b")
    assert [t.id for t in db.get_topics_detail([b, "topic_missing", a, b])] == [b, a]
    assert db.get_topics_detail([]) == []
    (header,) = db.get_topics_detail([a], with_entries=False)
    assert header.topic_name == "a" and header.decisions == []


def test_create_with_unknown_domain_rolls_back(db, space):
    with pytest.raises(DomainNotFoundError):
        db.apply_changes(
            TopicChangeSet(
                space_id=space.id,
                accept_time=now(),
                creates=[topic_create(name="ok"), topic_create(name="x", domain="不存在")],
            )
        )
    assert db.list_topics(space.id).total == 0


def test_get_entry_returns_decision_for_child_ids(db, space):
    topic_id = create(
        db,
        space,
        entries=[
            decision(
                history=[DecisionCard(content="A", chat_time=at(1), user_ids=[])],
                conflicts=[ConflictCard(content="C", chat_time=at(2), user_ids=[])],
            ),
            timeline(),
        ],
    )
    topic = detail(db, topic_id)
    (d,), (t,) = topic.decisions, topic.timeline
    for entry_id in (d.id, d.history[0].id, d.conflicts[0].id):
        got = db.get_entry(entry_id)
        assert got == d and (got.topic_id, got.space_id) == (topic_id, space.id)
    assert db.get_entry(t.id) == t
    assert db.get_entry("missing") is None


# ---------- update ----------
def test_update_fields_entries_and_sources(db, space):
    keep, replace, drop = decision("保留", 1), decision("旧结论", 2), decision("删除", 3)
    topic_id = create(db, space, entries=[keep, replace, drop], sources=[Source(user_id=["u1"])])
    by_content = {d.content: d for d in detail(db, topic_id).decisions}

    results = update(
        db,
        space,
        topic_id=topic_id,
        expected_version=1,
        domain="运维",
        topic_summary="新摘要",
        update_time=at(90),
        upsert_entries=[
            decision("新结论", 4, id=by_content["旧结论"].id),
            timeline("新进展", 40),
        ],
        delete_entry_ids=[by_content["删除"].id],
        add_sources=[Source(user_id=["u1"]), Source(user_id=["u2"], agent_id="codex")],
    )
    assert [(r.topic_id, r.operation) for r in results] == [(topic_id, "UPDATE")]
    topic = detail(db, topic_id)
    assert (topic.domain, topic.topic_summary, topic.topic_description, topic.version) == (
        "运维",
        "新摘要",
        "描述",
        2,
    )
    assert (topic.create_time, topic.update_time) == (at(0), at(90))
    assert {d.content: d.version for d in topic.decisions} == {"保留": 1, "新结论": 2}
    assert [t.content for t in topic.timeline] == ["新进展"]
    assert topic.sources == [Source(user_id=["u1"]), Source(user_id=["u2"], agent_id="codex")]
    update(db, space, topic_id=topic_id, expected_version=2, topic_summary="x")
    assert detail(db, topic_id).update_time == at(90)  # omitted: kept


def test_results_list_creates_then_updates(db, space):
    old = create(db, space)
    results = db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accept_time=now(),
            updates=[TopicUpdate(topic_id=old, expected_version=1, topic_summary="x")],
            creates=[topic_create(name="new")],
        )
    )
    assert [r.operation for r in results] == ["ADD", "UPDATE"] and results[1].topic_id == old


def test_version_conflict_rolls_back_whole_batch(db, space):
    a = create(db, space, entries=[decision("a")])
    b = create(db, space)
    update(db, space, topic_id=b, expected_version=1, topic_summary="v2")
    with pytest.raises(VersionConflictError):
        db.apply_changes(
            TopicChangeSet(
                space_id=space.id,
                accept_time=now(),
                creates=[topic_create(name="new")],
                updates=[
                    TopicUpdate(
                        topic_id=a,
                        expected_version=1,
                        topic_summary="written first",
                        upsert_entries=[timeline()],
                    ),
                    TopicUpdate(topic_id=b, expected_version=1, topic_summary="stale"),
                ],
            )
        )
    assert db.list_topics(space.id).total == 2
    topic_a = detail(db, a)
    assert (topic_a.topic_summary, topic_a.version, topic_a.timeline) == ("摘要", 1, [])
    assert detail(db, b).topic_summary == "v2"


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
    assert detail(db, topic_id).version == 1


def test_update_cannot_touch_topic_of_another_space(db, space):
    other = db.create_space("p", "other", domains=[Domain(domain="开发")])
    foreign = create(db, other)
    with pytest.raises(TopicNotFoundError):
        update(db, space, topic_id=foreign, expected_version=1, topic_summary="x")


def test_overwrite_cannot_change_entry_type(db, space):
    topic_id = create(db, space, entries=[timeline()])
    (t,) = detail(db, topic_id).timeline
    with pytest.raises(EntryNotFoundError):
        update(db, space, topic_id=topic_id, expected_version=1, upsert_entries=[decision(id=t.id)])


# ---------- decision child rows ----------
def test_history_is_append_only_and_kept_by_id(db, space):
    topic_id = create(
        db,
        space,
        entries=[decision("B", history=[DecisionCard(content="A", chat_time=at(1), user_ids=[])])],
    )
    (d,) = detail(db, topic_id).decisions
    (a,) = d.history
    tampered = a.model_copy(update={"content": "changed"})
    new = DecisionCard(content="B0", chat_time=at(5), user_ids=["user_a"], reason="r")
    update(
        db,
        space,
        topic_id=topic_id,
        expected_version=1,
        upsert_entries=[decision("C", id=d.id, history=[tampered, new])],
    )
    (d2,) = detail(db, topic_id).decisions
    assert d2.content == "C" and [h.content for h in d2.history] == ["A", "B0"]
    assert d2.history[0].id == a.id and d2.history[1].reason == "r"
    update(db, space, topic_id=topic_id, expected_version=2, upsert_entries=[decision(id=d.id)])
    assert [h.content for h in detail(db, topic_id).decisions[0].history] == ["A", "B0"]


def test_conflicts_replace_wholesale_and_keep_ids(db, space):
    cards = [ConflictCard(content=c, chat_time=at(i), user_ids=[]) for i, c in enumerate("XY")]
    topic_id = create(db, space, entries=[decision(conflicts=cards)])
    (d,) = detail(db, topic_id).decisions
    x, y = d.conflicts
    kept = x.model_copy(update={"content": "X2", "user_ids": ["user_b"]})
    update(
        db,
        space,
        topic_id=topic_id,
        expected_version=1,
        upsert_entries=[
            decision(
                id=d.id,
                conflicts=[kept, ConflictCard(content="Z", chat_time=at(9), user_ids=[])],
            )
        ],
    )
    (d2,) = detail(db, topic_id).decisions
    assert [(c.content, c.user_ids) for c in d2.conflicts] == [("X2", ["user_b"]), ("Z", [])]
    assert d2.conflicts[0].id == x.id
    assert db.get_entry(y.id) is None  # replaced away
    update(db, space, topic_id=topic_id, expected_version=2, upsert_entries=[decision(id=d.id)])
    assert detail(db, topic_id).decisions[0].conflicts == []


@pytest.mark.parametrize("field", ["history", "conflicts"])
def test_unknown_child_id_rolls_back(db, space, field):
    topic_id = create(db, space, entries=[decision()])
    (d,) = detail(db, topic_id).decisions
    card_type = DecisionCard if field == "history" else ConflictCard
    ghost = card_type(id="ghost", content="g", chat_time=at(1), user_ids=[])
    with pytest.raises(EntryNotFoundError):
        update(
            db,
            space,
            topic_id=topic_id,
            expected_version=1,
            topic_summary="x",
            upsert_entries=[decision("new", id=d.id, **{field: [ghost]})],
        )
    topic = detail(db, topic_id)
    assert (topic.version, topic.decisions[0].content) == (1, "采用方案B")
    with pytest.raises(EntryNotFoundError):  # a new decision cannot claim child ids
        update(
            db,
            space,
            topic_id=topic_id,
            expected_version=1,
            upsert_entries=[decision(**{field: [ghost]})],
        )


def test_delete_entry_ids_take_active_rows_and_cascade(db, space):
    topic_id = create(
        db,
        space,
        entries=[
            decision(
                "a",
                history=[DecisionCard(content="h", chat_time=at(1), user_ids=[])],
                conflicts=[ConflictCard(content="c", chat_time=at(2), user_ids=[])],
            ),
            decision("b"),
        ],
    )
    a = next(d for d in detail(db, topic_id).decisions if d.content == "a")
    update(  # child ids are not deletable on their own
        db, space, topic_id=topic_id, expected_version=1, delete_entry_ids=[a.history[0].id]
    )
    assert db.get_entry(a.history[0].id) == a
    update(db, space, topic_id=topic_id, expected_version=2, delete_entry_ids=[a.id])
    assert [d.content for d in detail(db, topic_id).decisions] == ["b"]
    assert db.get_entry(a.history[0].id) is None and db.get_entry(a.conflicts[0].id) is None


# ---------- clear and delete ----------
def test_clear_space_rejects_older_tasks(db, space):
    create(db, space)
    assert db.clear_space(space.id) == 1
    assert db.list_topics(space.id).total == 0
    cleared = db.list_spaces(space.project_id, [space.id])[0].clear_time
    assert cleared is not None
    assert [d.domain for d in db.list_domains(space.id)]  # domains kept
    # before and equal are both rejected (stamps derive from the DB clock, not the host's)
    for accept_time in (cleared - timedelta(seconds=1), cleared):
        with pytest.raises(SpaceClearedError):
            db.apply_changes(
                TopicChangeSet(space_id=space.id, accept_time=accept_time, creates=[topic_create()])
            )
    assert db.list_topics(space.id).total == 0
    db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accept_time=cleared + timedelta(seconds=1),
            creates=[topic_create(name="fresh")],
        )
    )
    assert db.list_topics(space.id).total == 1


def test_delete_topics_cascades_entries(db, space):
    a = create(db, space, entries=[decision()])
    b = create(db, space)
    (d,) = detail(db, a).decisions
    assert db.delete_topics([a, "topic_missing"]) == 1
    assert db.delete_topics([]) == 0
    assert [t.id for t in db.list_topics(space.id).items] == [b]
    assert db.list_entries(a, "decision").total == 0 and db.get_entry(d.id) is None


# ---------- update_decision ----------
def test_update_decision_replaces_content_and_clears_conflicts(db, space):
    topic_id = create(
        db,
        space,
        entries=[
            decision(
                history=[DecisionCard(content="A", chat_time=at(1), user_ids=[])],
                conflicts=[ConflictCard(content="C", chat_time=at(2), user_ids=[])],
            )
        ],
    )
    (old,) = detail(db, topic_id).decisions
    new = db.update_decision(old.id, old.update_time, "采用方案D", embedding=[0.2] * DIM)
    assert (new.id, new.content, new.conflicts, new.version) == (old.id, "采用方案D", [], 2)
    assert new.history == old.history and new.update_time > old.update_time
    assert db.get_entry(old.conflicts[0].id) is None
    assert detail(db, topic_id).version == 1  # topic version unchanged
    with pytest.raises(UpdateConflictError):
        db.update_decision(old.id, old.update_time, "stale")
    with pytest.raises(UpdateConflictError):  # a child row is not a decision
        db.update_decision(new.history[0].id, new.update_time, "x")


def test_update_decision_rejects_non_decision(db, space):
    topic_id = create(db, space, entries=[timeline()])
    (entry,) = detail(db, topic_id).timeline
    with pytest.raises(UpdateConflictError):
        db.update_decision(entry.id, entry.update_time, "x")


# ---------- list_topics ----------
def test_list_topics_ranks_by_importance(db, space):
    plain = create(db, space, name="plain", updated=600)
    # 11h older, but one open conflict (+12h) and one active decision (+4h): ranks first
    hot = create(
        db,
        space,
        name="hot",
        updated=600 - 11 * 60,
        entries=[decision(conflicts=[ConflictCard(content="c", chat_time=at(1), user_ids=[])])],
    )
    assert [t.id for t in db.list_topics(space.id).items] == [hot, plain]
    (d,) = detail(db, hot).decisions
    db.update_decision(d.id, d.update_time, "resolved")  # conflict gone: +4h only
    assert [t.id for t in db.list_topics(space.id).items] == [plain, hot]


def test_list_topics_pages_are_stable_on_ties(db, space):
    ids = [create(db, space, name=f"t{i}") for i in range(5)]  # identical rank keys
    pages = [db.list_topics(space.id, page=p, size=2) for p in (1, 2, 3)]
    seen = [t.id for page in pages for t in page.items]
    assert sorted(seen) == sorted(ids) and len(set(seen)) == 5
    assert {page.total for page in pages} == {5}
    assert db.list_topics(space.id, page=4, size=2).items == []


def test_list_topics_previews_per_type_order(db, space):
    conflict = [ConflictCard(content="c", chat_time=at(1), user_ids=[])]
    topic_id = create(
        db,
        space,
        entries=[
            decision("new", 9),
            decision("many users", 5, users=("a", "b")),
            decision("conflicted", 1, conflicts=conflict),
            decision("old", 0),
            experience(1, confidence=0.9, task_intent="sure"),
            experience(2, status="verified", confidence=0.3, task_intent="verified"),
            experience(3, confidence=0.5, task_intent="newer"),
            experience(0, confidence=0.5, task_intent="older"),
            *[timeline(f"t{i}", 30 + i) for i in range(5)],
        ],
    )
    (topic,) = db.list_topics(space.id, preview_size=3).items
    assert topic.id == topic_id
    assert [d.content for d in topic.decisions] == ["conflicted", "many users", "new"]
    assert all(d.history == [] and d.conflicts == [] for d in topic.decisions)
    assert [e.extra.card.task_intent for e in topic.experiences] == ["verified", "sure", "newer"]
    assert [t.content for t in topic.timeline] == ["t2", "t3", "t4"]  # newest 3, oldest first
    (empty,) = db.list_topics(space.id, preview_size=0).items
    assert empty.decisions == [] and empty.timeline == []


def test_list_topics_filters_are_or_of_and_groups(db, space):
    a = create(db, space, name="a", updated=10)
    b = create(db, space, name="b", updated=20)
    ta, tb = at(10), at(20)

    def ids(filters):
        return {t.id for t in db.list_topics(space.id, filters=filters).items}

    assert ids(None) == ids([]) == {a, b}
    assert ids([TopicFilter(update_time=TimeRange(gt=ta))]) == {b}
    both = TopicFilter(create_time=TimeRange(lte=at(0)), update_time=TimeRange(lte=ta))
    assert ids([both]) == {a}
    assert ids(
        [TopicFilter(update_time=TimeRange(lt=ta)), TopicFilter(update_time=TimeRange(gte=tb))]
    ) == {b}
    assert ids([TopicFilter()]) == {a, b}
    assert ids([TopicFilter(update_time=TimeRange(gt=tb))]) == set()
    assert db.list_topics(space.id, filters=[TopicFilter(update_time=TimeRange(gt=ta))]).total == 1


# ---------- list_entries ----------
def test_list_entries_by_type_with_paging(db, space):
    history = [DecisionCard(content="h", chat_time=at(0), user_ids=[])]
    topic_id = create(
        db,
        space,
        entries=[
            *[decision(f"d{i}", i, history=history) for i in range(3)],
            *[timeline(f"t{i}", 50 - i) for i in range(3)],
        ],
    )
    page = db.list_entries(topic_id, "decision", page=1, size=2)
    assert page.total == 3 and [d.content for d in page.items] == ["d2", "d1"]
    assert page.items[0].history[0].content == "h"
    assert [d.content for d in db.list_entries(topic_id, "decision", page=2, size=2).items] == [
        "d0"
    ]
    assert [t.content for t in db.list_entries(topic_id, "timeline").items] == ["t2", "t1", "t0"]
    assert db.list_entries(topic_id, "experience").total == 0


def test_list_entries_filters_compare_chat_time(db, space):
    topic_id = create(db, space, entries=[decision(f"d{i}", i) for i in range(4)])
    page = db.list_entries(
        topic_id,
        "decision",
        filters=[
            TopicFilter(update_time=TimeRange(lte=at(0))),
            TopicFilter(create_time=TimeRange(gte=at(2))),
        ],
    )
    assert page.total == 3 and {d.content for d in page.items} == {"d0", "d2", "d3"}


def test_missing_space_and_unknown_ids(db):
    with pytest.raises(SpaceNotFoundError):
        db.apply_changes(TopicChangeSet(space_id="missing", accept_time=now()))
    with pytest.raises(SpaceNotFoundError):
        db.clear_space("missing")
    assert db.get_topics_detail(["topic_missing"]) == []
    assert db.list_topics("missing").total == 0


# ---------- edge cases ----------
def test_anchors_replaced_only_when_given(db, space):
    topic_id = create(db, space)
    update(db, space, topic_id=topic_id, expected_version=1, anchors=[{"path": "a.py"}])
    update(db, space, topic_id=topic_id, expected_version=2, topic_summary="x")
    assert [a.model_dump() for a in detail(db, topic_id).anchors] == [{"path": "a.py"}]
    update(db, space, topic_id=topic_id, expected_version=3, anchors=[])
    assert detail(db, topic_id).anchors == []


def test_entries_of_another_topic_are_untouchable(db, space):
    a = create(db, space, entries=[decision("a")])
    b = create(db, space, entries=[decision("b")])
    (b_decision,) = detail(db, b).decisions
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
    history = [DecisionCard(content="h", chat_time=at(0), user_ids=[])]
    entries = [decision(f"d{i}", i, history=history) for i in range(150)]
    topic_id = create(db, space, entries=entries)
    page = db.list_entries(topic_id, "decision", size=200)
    assert page.total == 150 and all(len(d.history) == 1 for d in page.items)


def test_upsert_bumps_entry_version_and_update_decision_keeps_topic_version(db, space):
    topic_id = create(db, space, entries=[decision("v1")])
    (d,) = detail(db, topic_id).decisions
    update(
        db, space, topic_id=topic_id, expected_version=1, upsert_entries=[decision("v2", id=d.id)]
    )
    (d2,) = detail(db, topic_id).decisions
    assert (d2.version, d2.create_time) == (2, d.create_time) and d2.update_time > d.update_time
    db.update_decision(d2.id, d2.update_time, "v3")
    topic = detail(db, topic_id)
    assert topic.version == 2 and topic.decisions[0].content == "v3"


def test_naive_datetimes_are_rejected(db, space):
    from pydantic import ValidationError

    naive = datetime(2026, 11, 1)
    with pytest.raises(ValidationError):
        TopicChangeSet(space_id=space.id, accept_time=naive)
    with pytest.raises(ValidationError):
        TimeRange(gt=naive)
    with pytest.raises(ValidationError):
        Decision(content="x", chat_time=naive, user_ids=[])
    with pytest.raises(ValueError):
        db.update_decision("d", naive, "x")
