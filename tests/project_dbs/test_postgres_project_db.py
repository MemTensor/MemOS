"""Integration tests against a real PostgreSQL + pgvector.

WARNING: drops and recreates the schema ``project_memory`` in the target database.
Set PROJECT_DB_TEST_HOST (and optionally _PORT/_USER/_PASSWORD/_NAME) to run, e.g.
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg17
"""

import os

import pytest


HOST = os.getenv("PROJECT_DB_TEST_HOST")
pytestmark = pytest.mark.skipif(not HOST, reason="PROJECT_DB_TEST_HOST not set")


@pytest.fixture
def db():
    psycopg2 = pytest.importorskip("psycopg2")
    from memos.configs.project_db import PostgresProjectDBConfig
    from memos.project_dbs.postgres import PostgresProjectDB

    kwargs = {
        "host": HOST,
        "port": int(os.getenv("PROJECT_DB_TEST_PORT", "5432")),
        "user": os.getenv("PROJECT_DB_TEST_USER", "postgres"),
        "password": os.getenv("PROJECT_DB_TEST_PASSWORD", "postgres"),
        "dbname": os.getenv("PROJECT_DB_TEST_NAME", "postgres"),
    }
    conn = psycopg2.connect(**kwargs)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cur.execute("DROP SCHEMA IF EXISTS project_memory CASCADE")
    conn.close()
    kwargs["db_name"] = kwargs.pop("dbname")
    store = PostgresProjectDB(PostgresProjectDBConfig(**kwargs))
    yield store
    store.close()


def test_init_creates_tables_and_is_idempotent(db):
    db._init_schema()  # second run must not fail
    with db._tx() as cur:
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
