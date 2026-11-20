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
        with pytest.raises(ProjectDBError, match="pgvector"):
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
        pg_db._lock_space(cur, space.id)  # what create/update_domains hold
        inserted = threading.Event()
        t = threading.Thread(target=lambda: (add_topic(pg_db, space.id, "开发"), inserted.set()))
        t.start()
        assert inserted.wait(5), "topic insert blocked by the domain-writer lock"
    t.join()
    pg_db.delete_space(space.id)
