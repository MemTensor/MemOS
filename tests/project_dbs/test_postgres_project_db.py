"""PostgreSQL-only checks; see conftest.py for how to enable them."""

import pytest

from tests.project_dbs.conftest import DIM


def _episode(pg_db, space_id, topic_id, start=1, end=1, conversation="c1"):
    import uuid

    episode_id = str(uuid.uuid4())
    with pg_db._tx() as cur:
        cur.execute(
            """INSERT INTO project_memory.episodes (id, space_id, conversation_key,
                   message_seq_start, message_seq_end, topic_id, first_chat_time, last_chat_time)
               VALUES (%s, %s, %s, %s, %s, %s, now(), now())""",
            (episode_id, space_id, conversation, start, end, topic_id),
        )
    return episode_id


def test_search_topics_recalls_and_filters_candidates(pg_db):
    from datetime import datetime, timedelta, timezone

    from memos.project_dbs.item import Domain, TimeRange, TopicChangeSet, TopicCreate, TopicFilter

    now = datetime.now(timezone.utc)
    old = now - timedelta(days=1)
    vector = [1.0, 0.0] + [0.0] * (pg_db.config.embedding_dimension - 2)
    other_vector = [0.0, 1.0, *vector[2:]]
    domains = [Domain(domain="dev"), Domain(domain="ops")]
    space = pg_db.create_space("search-project", "search", domains=domains)
    other_space = pg_db.create_space("other-project", "other", domains=domains)

    def create(space_id, name, embedding, domain="dev"):
        (result,) = pg_db.apply_changes(
            TopicChangeSet(
                space_id=space_id,
                accept_time=now,
                creates=[
                    TopicCreate(
                        domain=domain,
                        topic_name=name,
                        topic_summary="summary",
                        topic_description="description",
                        embedding=embedding,
                        create_time=old if name.endswith("older") else now,
                        update_time=old if name.endswith("older") else now,
                    )
                ],
            )
        )
        return result.topic_id

    both = create(space.id, "rollback", vector)
    vector_only = create(space.id, "migration", other_vector)
    text_only = create(space.id, "rollback notes", None)
    create(space.id, "rollback older", vector)
    create(space.id, "rollback operations", vector, domain="ops")
    create(other_space.id, "rollback unscoped", vector)

    filters = [TopicFilter(update_time=TimeRange(gte=now - timedelta(hours=1)))]
    kwargs = {"domains": ["dev"], "filters": filters}
    hits = pg_db.search_topics_by_embedding([space.id], vector, **kwargs)
    assert [hit.topic.id for hit in hits] == [both, vector_only]
    assert [hit.score for hit in hits] == pytest.approx([1.0, 0.0])

    hits = pg_db.search_topics_by_fulltext([space.id], "rollback", **kwargs)
    assert {hit.topic.id for hit in hits} == {both, text_only}
    assert hits[0].score >= hits[1].score > 0
    one_hit = pg_db.search_topics_by_embedding([space.id], vector, top_k=1, **kwargs)
    assert [hit.topic.id for hit in one_hit] == [both]
    assert pg_db.search_topics_by_embedding([space.id], vector, top_k=0) == []
    assert pg_db.search_topics_by_embedding([], vector) == []
    assert pg_db.search_topics_by_fulltext([], "rollback") == []
    assert pg_db.search_topics_by_fulltext([space.id], "  ") == []
    assert pg_db.search_topics_by_fulltext([space.id], "rollback", top_k=1, **kwargs) == hits[:1]
    # any term matches; more matched terms rank higher
    hits = pg_db.search_topics_by_fulltext([space.id], "notes nothing", **kwargs)
    assert [hit.topic.id for hit in hits] == [text_only]
    hits = pg_db.search_topics_by_fulltext([space.id], "rollback notes", **kwargs)
    assert [hit.topic.id for hit in hits] == [text_only, both]


def test_init_creates_tables_and_is_idempotent(pg_db):
    pg_db._init_schema()  # second run must not fail
    with pg_db._tx() as cur:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'project_memory' ORDER BY table_name"
        )
        assert [r[0] for r in cur.fetchall()] == [
            "domains",
            "episodes",
            "messages",
            "project_entries",
            "spaces",
            "topics",
        ]


def test_delete_space_removes_topics_and_entries(pg_db):
    from memos.project_dbs.item import Domain
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    topic_id = add_topic(pg_db, space.id, "开发")
    _episode(pg_db, space.id, topic_id)
    pg_db.delete_space(space.id)
    with pg_db._tx() as cur:
        for table in ("spaces", "domains", "topics", "project_entries", "episodes"):
            column = "id" if table == "spaces" else "space_id"
            cur.execute(
                f"SELECT count(*) FROM project_memory.{table} WHERE {column} = %s", (space.id,)
            )
            assert cur.fetchone()[0] == 0, table


def _config(pg_db, **overrides):
    from memos.configs.project_db import PostgresProjectDBConfig

    return PostgresProjectDBConfig(
        **{**pg_db.config.model_dump(exclude={"model_schema"}), **overrides}
    )


def test_factory_builds_postgres_backend(pg_db):
    from memos.configs.project_db import ProjectDBConfigFactory
    from memos.project_dbs.factory import ProjectDBFactory
    from memos.project_dbs.postgres import PostgresProjectDB

    factory = ProjectDBConfigFactory(
        backend="postgres", config=_config(pg_db).model_dump(exclude={"model_schema"})
    )
    store = ProjectDBFactory.from_config(factory)
    try:
        assert isinstance(store, PostgresProjectDB)
        assert store.list_domains("missing") == []
    finally:
        store.close()


def test_missing_pgvector_fails_and_closes_pool(pg_db):
    import psycopg2

    from memos.project_dbs.exceptions import ProjectDBError
    from memos.project_dbs.postgres import PostgresProjectDB

    cfg = pg_db.config
    admin = psycopg2.connect(
        host=cfg.host, port=cfg.port, user=cfg.user, password=cfg.password, dbname=cfg.db_name
    )
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute("DROP DATABASE IF EXISTS project_db_novector")
        cur.execute("CREATE DATABASE project_db_novector")
    try:
        with pytest.raises(ProjectDBError, match="vector"):
            PostgresProjectDB(_config(pg_db, db_name="project_db_novector"))
        with admin.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = 'project_db_novector'"
            )
            assert cur.fetchone()[0] == 0  # pool was closed
    finally:
        with admin.cursor() as cur:
            cur.execute("DROP DATABASE IF EXISTS project_db_novector")
        admin.close()


def test_lost_connection_fails_once_then_recovers(pg_db):
    import psycopg2

    from memos.project_dbs.postgres import PostgresProjectDB

    store = PostgresProjectDB(_config(pg_db, minconn=1, maxconn=1))
    try:
        with store._tx() as cur:
            cur.execute("SELECT pg_backend_pid()")
            pid = cur.fetchone()[0]
        with pg_db._tx() as cur:
            cur.execute("SELECT pg_terminate_backend(%s)", (pid,))
        with pytest.raises(psycopg2.Error):
            store.list_domains("missing")  # the pooled connection is dead
        assert store.list_domains("missing") == []  # the pool opened a new one
    finally:
        store.close()


def test_domain_cap_holds_under_concurrent_batches(pg_db):
    import threading

    from memos.project_dbs.exceptions import DomainLimitExceededError
    from memos.project_dbs.item import Domain

    space = pg_db.create_space("p", "s", domains=[Domain(domain=f"d{i}") for i in range(15)])
    results = []

    def register(i):
        try:
            pg_db.create_domains(space.id, [Domain(domain=f"t{i}_{j}") for j in range(3)])
            results.append("ok")
        except DomainLimitExceededError:
            results.append("limit")

    threads = [threading.Thread(target=register, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == ["limit"] * 5 + ["ok"]
    assert len(pg_db.list_domains(space.id)) == 18
    pg_db.delete_space(space.id)


def test_domain_writers_do_not_block_topic_inserts(pg_db):
    import threading

    from memos.project_dbs.item import Domain
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    with pg_db._tx() as cur:
        pg_db._lock_space(cur, space.id)  # what create_domains holds; apply_changes must not wait
        inserted = threading.Event()
        t = threading.Thread(target=lambda: (add_topic(pg_db, space.id, "开发"), inserted.set()))
        t.start()
        assert inserted.wait(5), "topic insert blocked by the domain-writer lock"
    t.join()
    pg_db.delete_space(space.id)


def test_delete_space_waits_for_in_flight_topic_insert(pg_db):
    import threading
    import uuid

    from memos.project_dbs.item import Domain

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    (domain,) = pg_db.list_domains(space.id)
    done = threading.Event()
    with pg_db._tx() as cur:  # an organizer transaction that has inserted a topic
        cur.execute(
            """INSERT INTO project_memory.topics (id, space_id, domain_id, topic_name,
                   topic_summary, topic_description, create_time, update_time)
               VALUES (%s, %s, %s, 'n', 's', 'd', now(), now())""",
            (str(uuid.uuid4()), space.id, domain.id),
        )
        t = threading.Thread(target=lambda: (pg_db.delete_space(space.id), done.set()))
        t.start()
        assert not done.wait(0.5), "delete_space should wait for the topic insert"
    t.join(5)
    assert done.is_set()
    with pg_db._tx() as cur:
        cur.execute("SELECT count(*) FROM project_memory.topics WHERE space_id = %s", (space.id,))
        assert cur.fetchone()[0] == 0


def test_init_tolerates_existing_text_search_config(pg_db):
    with pg_db._tx() as cur:  # tables gone, configuration left behind
        cur.execute(
            "DROP TABLE project_memory.episodes, "
            "project_memory.messages, project_memory.project_entries, project_memory.topics, "
            "project_memory.domains, project_memory.spaces"
        )
    pg_db._init_schema()
    with pg_db._tx() as cur:
        cur.execute("SELECT to_regclass('project_memory.project_entries')")
        assert cur.fetchone()[0] is not None


def test_clear_space_waits_for_in_flight_write_back(pg_db):
    import threading

    from memos.project_dbs.item import Domain
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    add_topic(pg_db, space.id, "开发")
    done = threading.Event()
    with pg_db._tx() as cur:  # what apply_changes holds while writing back
        cur.execute("SELECT 1 FROM project_memory.spaces WHERE id = %s FOR KEY SHARE", (space.id,))
        t = threading.Thread(target=lambda: (pg_db.clear_space(space.id), done.set()))
        t.start()
        assert not done.wait(0.5), "clear_space should wait for the write-back"
    t.join(5)
    assert done.is_set()
    assert pg_db.list_topics(space.id).total == 0
    pg_db.delete_space(space.id)


def test_written_rows_have_embedding_and_search_tsv(pg_db):
    from memos.project_dbs.item import Domain
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    topic_id = add_topic(pg_db, space.id, "开发")
    with pg_db._tx() as cur:
        cur.execute(
            "SELECT search_tsv IS NOT NULL FROM project_memory.topics WHERE id = %s", (topic_id,)
        )
        assert cur.fetchone()[0]
        cur.execute(
            "SELECT count(*) FROM project_memory.project_entries "
            "WHERE topic_id = %s AND search_tsv IS NOT NULL",
            (topic_id,),
        )
        assert cur.fetchone()[0] == 1
    pg_db.delete_space(space.id)


def _embedding(pg_db, table: str, row_id: str):
    with pg_db._tx() as cur:
        cur.execute(
            f"SELECT embedding IS NOT NULL FROM project_memory.{table} WHERE id = %s", (row_id,)
        )
        return cur.fetchone()[0]


def test_embeddings_are_written_kept_and_replaced(pg_db):
    from datetime import datetime, timezone

    from memos.project_dbs.item import (
        ConflictCard,
        Decision,
        DecisionCard,
        Domain,
        TopicChangeSet,
        TopicCreate,
        TopicUpdate,
    )

    now = datetime.now(timezone.utc)
    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    vec = [0.1] * DIM
    history = [DecisionCard(content="h", chat_time=now, user_ids=[], embedding=vec)]
    conflicts = [ConflictCard(content="c", chat_time=now, user_ids=[], embedding=vec)]
    (created,) = pg_db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accept_time=now,
            creates=[
                TopicCreate(
                    domain="开发", topic_name="n", topic_summary="s", topic_description="d",
                    embedding=vec, create_time=now, update_time=now,
                    entries=[Decision(content="c", chat_time=now, user_ids=[], embedding=vec,
                                      history=history, conflicts=conflicts)],
                )
            ],
        )
    )  # fmt: skip
    topic_id = created.topic_id
    (d,) = pg_db.get_topics_detail([topic_id])[0].decisions
    assert _embedding(pg_db, "topics", topic_id) and _embedding(pg_db, "project_entries", d.id)
    assert _embedding(pg_db, "project_entries", d.history[0].id)
    assert _embedding(pg_db, "project_entries", d.conflicts[0].id)

    def apply_update(**kw):
        pg_db.apply_changes(
            TopicChangeSet(
                space_id=space.id,
                accept_time=datetime.now(timezone.utc),
                updates=[TopicUpdate(topic_id=topic_id, **kw)],
            )
        )

    apply_update(expected_version=1, topic_summary="x")  # no embedding: topic vector kept
    assert _embedding(pg_db, "topics", topic_id)
    kept = d.conflicts[0].model_copy(update={"embedding": None})
    apply_update(
        expected_version=2,
        upsert_entries=[
            Decision(id=d.id, content="c2", chat_time=now, user_ids=[], conflicts=[kept])
        ],
    )
    assert not _embedding(pg_db, "project_entries", d.id)  # whole-entry replace clears it
    assert not _embedding(pg_db, "project_entries", kept.id)  # so does a kept conflict
    assert _embedding(pg_db, "project_entries", d.history[0].id)  # history is untouched
    (d,) = pg_db.get_topics_detail([topic_id])[0].decisions
    pg_db.update_decision(d.id, d.update_time, "c3", embedding=vec)
    assert _embedding(pg_db, "project_entries", d.id)
    pg_db.delete_space(space.id)


def test_real_write_back_blocks_clear_space(pg_db, monkeypatch):
    import threading
    import time as _time

    from datetime import datetime, timezone

    from memos.project_dbs.item import Domain, TopicChangeSet, TopicUpdate
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    topic_id = add_topic(pg_db, space.id, "开发")
    from memos.project_dbs import postgres_writer

    original = postgres_writer._update_topic
    started = threading.Event()

    def slow_update(*args, **kwargs):
        started.set()
        _time.sleep(0.5)
        return original(*args, **kwargs)

    monkeypatch.setattr(postgres_writer, "_update_topic", slow_update)
    writer = threading.Thread(
        target=pg_db.apply_changes,
        args=(
            TopicChangeSet(
                space_id=space.id,
                accept_time=datetime.now(timezone.utc),
                updates=[TopicUpdate(topic_id=topic_id, expected_version=1, topic_summary="x")],
            ),
        ),
    )
    writer.start()
    assert started.wait(5)
    began = _time.monotonic()
    assert pg_db.clear_space(space.id) == 1  # waits for the write-back, then clears it
    assert _time.monotonic() - began > 0.2
    writer.join(5)
    pg_db.delete_space(space.id)


def test_task_accepted_while_clear_waits_is_rejected(pg_db, monkeypatch):
    import threading
    import time as _time

    from datetime import datetime, timezone

    from memos.project_dbs.exceptions import SpaceClearedError
    from memos.project_dbs.item import Domain, TopicChangeSet, TopicCreate, TopicUpdate
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    topic_id = add_topic(pg_db, space.id, "开发")
    from memos.project_dbs import postgres_writer

    original = postgres_writer._update_topic
    in_write_back = threading.Event()

    def slow_update(*args, **kwargs):
        in_write_back.set()
        _time.sleep(0.6)
        return original(*args, **kwargs)

    monkeypatch.setattr(postgres_writer, "_update_topic", slow_update)
    writer = threading.Thread(
        target=pg_db.apply_changes,
        args=(
            TopicChangeSet(
                space_id=space.id,
                accept_time=datetime.now(timezone.utc),
                updates=[TopicUpdate(topic_id=topic_id, expected_version=1, topic_summary="x")],
            ),
        ),
    )
    writer.start()
    assert in_write_back.wait(5)
    clearer = threading.Thread(target=pg_db.clear_space, args=(space.id,))
    clearer.start()  # starts now, waits for the write-back
    _time.sleep(0.2)
    late = TopicChangeSet(  # accepted while the clear is waiting
        space_id=space.id,
        accept_time=datetime.now(timezone.utc),
        creates=[
            TopicCreate(
                domain="开发",
                topic_name="late",
                topic_summary="s",
                topic_description="d",
                create_time=datetime.now(timezone.utc),
                update_time=datetime.now(timezone.utc),
            )
        ],
    )
    writer.join(5)
    clearer.join(5)
    monkeypatch.undo()
    with pytest.raises(SpaceClearedError):
        pg_db.apply_changes(late)
    assert pg_db.list_topics(space.id).total == 0
    pg_db.delete_space(space.id)


def test_opposite_order_updates_do_not_deadlock(pg_db, monkeypatch):
    import threading
    import time as _time

    from datetime import datetime, timezone

    from memos.project_dbs.exceptions import VersionConflictError
    from memos.project_dbs.item import Domain, TopicChangeSet, TopicUpdate
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    a, b = add_topic(pg_db, space.id, "开发"), add_topic(pg_db, space.id, "开发")
    from memos.project_dbs import postgres_writer

    original = postgres_writer._update_topic

    def slow_update(*args, **kwargs):
        result = original(*args, **kwargs)
        _time.sleep(0.2)  # widen the window between the two topic updates
        return result

    monkeypatch.setattr(postgres_writer, "_update_topic", slow_update)
    outcomes = []

    def run(order):
        try:
            pg_db.apply_changes(
                TopicChangeSet(
                    space_id=space.id,
                    accept_time=datetime.now(timezone.utc),
                    updates=[
                        TopicUpdate(topic_id=t, expected_version=1, topic_summary="x")
                        for t in order
                    ],
                )
            )
            outcomes.append("ok")
        except VersionConflictError:
            outcomes.append("conflict")
        except Exception as e:
            outcomes.append(type(e).__name__)

    threads = [threading.Thread(target=run, args=(o,)) for o in ([a, b], [b, a])]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(outcomes) == ["conflict", "ok"]
    pg_db.delete_space(space.id)


# ---------- derived columns, ranking and the shared writer ----------
def _row(pg_db, sql, params):
    with pg_db._tx() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def test_derived_columns_commit_time_and_rank_are_written(pg_db):
    from datetime import datetime, timedelta, timezone

    from memos.project_dbs.item import (
        ConflictCard,
        Decision,
        Domain,
        Source,
        TopicChangeSet,
        TopicCreate,
        TopicUpdate,
    )

    chat = datetime(2026, 1, 1, tzinfo=timezone.utc)
    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    conflict = ConflictCard(content="c", chat_time=chat, user_ids=["bob"])
    (created,) = pg_db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accept_time=datetime.now(timezone.utc),
            creates=[
                TopicCreate(
                    domain="开发",
                    topic_name="n",
                    topic_summary="s",
                    topic_description="d",
                    create_time=chat,
                    update_time=chat,
                    sources=[
                        Source(conversation_id="c1", user_id=["alice"]),
                        Source(user_id=["carol"]),
                    ],
                    anchors=[{"key": "file:a.py", "x": 1}, {"path": "b.py"}],
                    entries=[Decision(content="d", chat_time=chat, user_ids=["alice"],
                                      conflicts=[conflict])],
                )
            ],
        )
    )  # fmt: skip
    topic_id = created.topic_id
    sql = """SELECT conversation_ids, anchor_keys, commit_time, extra, create_time
             FROM project_memory.topics WHERE id = %s"""
    ids, keys, commit_time, extra, create_time = _row(pg_db, sql, (topic_id,))
    assert ids == ["c1"] and keys == ["file:a.py", '{"path": "b.py"}']
    assert create_time == chat and commit_time > chat  # commit_time is server time
    # 1 conflict (12h) + 1 decision (4h) + 2 members alice/carol (6h); bob only backs the
    # conflict, which is not ACTIVE; 1 conversation (0h)
    assert extra["rank"] == {
        "open_conflicts": 12,
        "active_decisions": 4,
        "verified_experiences": 0,
        "members": 6,
        "conversations": 0,
        "total": 22,
    }
    assert datetime.fromisoformat(extra["rank_time"]) == chat + timedelta(hours=22)
    pg_db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accept_time=datetime.now(timezone.utc),
            updates=[
                TopicUpdate(
                    topic_id=topic_id,
                    expected_version=1,
                    add_sources=[Source(conversation_id="c2", user_id=["dave"])],
                    anchors=[{"key": "k"}],
                )
            ],
        )
    )
    ids, keys, commit_time2, extra, _ = _row(pg_db, sql, (topic_id,))
    assert ids == ["c1", "c2"] and keys == ["k"] and commit_time2 > commit_time
    assert (extra["rank"]["members"], extra["rank"]["conversations"]) == (12, 3)
    pg_db.delete_space(space.id)


def test_write_change_set_runs_in_the_callers_transaction(pg_db):
    from datetime import datetime, timezone

    from psycopg2.extras import RealDictCursor

    from memos.project_dbs.item import Domain, TopicChangeSet, TopicCreate
    from memos.project_dbs.postgres import write_change_set

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    stamp = datetime(2026, 2, 2, tzinfo=timezone.utc)
    change_set = TopicChangeSet(
        space_id=space.id,
        accept_time=datetime.now(timezone.utc),
        creates=[
            TopicCreate(domain="开发", topic_name="n", topic_summary="s", topic_description="d",
                        create_time=stamp, update_time=stamp)
        ],
    )  # fmt: skip
    conn = pg_db.pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:  # what Add hands in
            (result,) = write_change_set(cur, change_set, now=stamp)
            cur.execute("SELECT commit_time FROM project_memory.topics WHERE id = %s",
                        (result.topic_id,))  # fmt: skip
            assert cur.fetchone()["commit_time"] == stamp  # visible inside the transaction
        conn.rollback()  # the caller decides
    finally:
        pg_db.pool.putconn(conn)
    assert pg_db.list_topics(space.id).total == 0
    pg_db.delete_space(space.id)


def test_reads_expose_active_entries_only(pg_db):
    from datetime import datetime, timezone

    from memos.project_dbs.item import (
        Domain,
        EntryStatus,
        Experience,
        TopicChangeSet,
        TopicCreate,
    )

    now = datetime.now(timezone.utc)
    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    card = {"task_intent": "a", "problem": "b", "principle": "c"}
    (created,) = pg_db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accept_time=now,
            creates=[
                TopicCreate(domain="开发", topic_name="n", topic_summary="s",
                            topic_description="d", create_time=now, update_time=now,
                            entries=[Experience(content="", chat_time=now, user_ids=[],
                                                extra={"card": card})])
            ],
        )
    )  # fmt: skip
    (exp,) = pg_db.get_topics_detail([created.topic_id])[0].experiences
    with pg_db._tx() as cur:  # retire it the way the migration does
        cur.execute("UPDATE project_memory.project_entries SET status = 1 WHERE id = %s", (exp.id,))
    assert pg_db.get_topics_detail([created.topic_id])[0].experiences == []
    assert pg_db.list_topics(space.id).items[0].experiences == []
    assert pg_db.list_entries(created.topic_id, "experience").total == 0
    assert pg_db.get_entry(exp.id).status == EntryStatus.ARCHIVED  # direct reads still work
    pg_db.delete_space(space.id)


def test_deleting_or_clearing_topics_unfiles_episodes(pg_db):
    from memos.project_dbs.item import Domain
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    a, b = add_topic(pg_db, space.id, "开发"), add_topic(pg_db, space.id, "开发")
    ea, eb = _episode(pg_db, space.id, a, 1, 2), _episode(pg_db, space.id, b, 3, 4)
    sql = "SELECT topic_id FROM project_memory.episodes WHERE id = %s"
    assert pg_db.delete_topics([a]) == 1
    assert _row(pg_db, sql, (ea,)) == (None,) and _row(pg_db, sql, (eb,)) == (b,)
    assert pg_db.clear_space(space.id) == 1
    assert _row(pg_db, sql, (eb,)) == (None,)  # Episodes stay, unfiled
    pg_db.delete_space(space.id)
