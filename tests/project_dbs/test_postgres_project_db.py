"""PostgreSQL-only checks; see conftest.py for how to enable them."""

import pytest


def test_init_creates_tables_and_is_idempotent(pg_db):
    pg_db._init_schema()  # second run must not fail
    with pg_db._tx() as cur:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'project_memory' ORDER BY table_name"
        )
        assert [r[0] for r in cur.fetchall()] == [
            "domains",
            "project_entries",
            "spaces",
            "topics",
        ]


def test_delete_space_removes_topics_and_entries(pg_db):
    from memos.project_dbs.item import Domain
    from tests.project_dbs.conftest import add_topic

    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    add_topic(pg_db, space.id, "开发")
    pg_db.delete_space(space.id)
    with pg_db._tx() as cur:
        for table in ("spaces", "domains", "topics", "project_entries"):
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
            """INSERT INTO project_memory.topics
                   (id, space_id, domain_id, topic_name, topic_summary, topic_description)
               VALUES (%s, %s, %s, 'n', 's', 'd')""",
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
            "DROP TABLE project_memory.project_entries, project_memory.topics, "
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

    from memos.project_dbs.item import Decision, Domain, TopicChangeSet, TopicCreate, TopicUpdate

    now = datetime.now(timezone.utc)
    space = pg_db.create_space("p", "s", domains=[Domain(domain="开发")])
    vec = [0.1] * 1024
    (created,) = pg_db.apply_changes(
        TopicChangeSet(
            space_id=space.id,
            accepted_at=now,
            creates=[
                TopicCreate(
                    domain="开发", topic_name="n", topic_summary="s", topic_description="d",
                    embedding=vec,
                    entries=[Decision(content="c", time=now, user_ids=[], embedding=vec)],
                )
            ],
        )
    )  # fmt: skip
    topic_id = created.topic_id
    (d,) = pg_db.get_topics([topic_id])[0].decisions
    assert _embedding(pg_db, "topics", topic_id) and _embedding(pg_db, "project_entries", d.id)

    def apply_update(**kw):
        pg_db.apply_changes(
            TopicChangeSet(
                space_id=space.id,
                accepted_at=datetime.now(timezone.utc),
                updates=[TopicUpdate(topic_id=topic_id, **kw)],
            )
        )

    apply_update(expected_version=1, topic_summary="x")  # no embedding: topic vector kept
    assert _embedding(pg_db, "topics", topic_id)
    apply_update(
        expected_version=2, upsert_entries=[Decision(id=d.id, content="c2", time=now, user_ids=[])]
    )
    assert not _embedding(pg_db, "project_entries", d.id)  # whole-entry replace clears it
    (d,) = pg_db.get_topics([topic_id])[0].decisions
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
    original = type(pg_db)._update_topic
    started = threading.Event()

    def slow_update(self, *args, **kwargs):
        started.set()
        _time.sleep(0.5)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(type(pg_db), "_update_topic", slow_update)
    writer = threading.Thread(
        target=pg_db.apply_changes,
        args=(
            TopicChangeSet(
                space_id=space.id,
                accepted_at=datetime.now(timezone.utc),
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
    original = type(pg_db)._update_topic
    in_write_back = threading.Event()

    def slow_update(self, *args, **kwargs):
        in_write_back.set()
        _time.sleep(0.6)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(type(pg_db), "_update_topic", slow_update)
    writer = threading.Thread(
        target=pg_db.apply_changes,
        args=(
            TopicChangeSet(
                space_id=space.id,
                accepted_at=datetime.now(timezone.utc),
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
        accepted_at=datetime.now(timezone.utc),
        creates=[
            TopicCreate(domain="开发", topic_name="late", topic_summary="s", topic_description="d")
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
    original = type(pg_db)._update_topic

    def slow_update(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        _time.sleep(0.2)  # widen the window between the two topic updates
        return result

    monkeypatch.setattr(type(pg_db), "_update_topic", slow_update)
    outcomes = []

    def run(order):
        try:
            pg_db.apply_changes(
                TopicChangeSet(
                    space_id=space.id,
                    accepted_at=datetime.now(timezone.utc),
                    updates=[
                        TopicUpdate(topic_id=t, expected_version=1, topic_summary="x")
                        for t in order
                    ],
                )
            )
            outcomes.append("ok")
        except VersionConflictError:
            outcomes.append("conflict")
        except Exception as e:  # noqa: BLE001 - record DeadlockDetected etc. as a failure
            outcomes.append(type(e).__name__)

    threads = [threading.Thread(target=run, args=(o,)) for o in ([a, b], [b, a])]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(outcomes) == ["conflict", "ok"]
    pg_db.delete_space(space.id)
