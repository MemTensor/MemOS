"""Fixtures for project_dbs tests.

``db`` runs each contract test against the in-memory fake and, when
PROJECT_DB_TEST_HOST is set, against a real PostgreSQL + pgvector, e.g.
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg17

WARNING: the PostgreSQL run drops and recreates the schema ``project_memory``
in the target database (PROJECT_DB_TEST_NAME, default ``postgres``).
"""

import os

import pytest

from tests.project_dbs.fake import FakeProjectDB


HOST = os.getenv("PROJECT_DB_TEST_HOST")
# Small vectors keep the PostgreSQL tests fast; production uses 1024.
DIM = 8


def pg_kwargs() -> dict:
    return {
        "host": HOST,
        "port": int(os.getenv("PROJECT_DB_TEST_PORT", "5432")),
        "user": os.getenv("PROJECT_DB_TEST_USER", "postgres"),
        "password": os.getenv("PROJECT_DB_TEST_PASSWORD", "postgres"),
        "dbname": os.getenv("PROJECT_DB_TEST_NAME", "postgres"),
    }


@pytest.fixture(scope="session")
def pg_conn():
    """Autocommit admin connection with the required extensions installed."""
    if not HOST:
        pytest.skip("PROJECT_DB_TEST_HOST not set")
    psycopg2 = pytest.importorskip("psycopg2")
    conn = psycopg2.connect(**pg_kwargs())
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cur.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    yield conn
    conn.close()


@pytest.fixture
def scratch_schema(pg_conn):
    """Factory for throwaway schemas; dropped after the test."""
    created = []

    def make(name: str) -> str:
        with pg_conn.cursor() as cur:
            cur.execute(f"DROP SCHEMA IF EXISTS {name} CASCADE")
        created.append(name)
        return name

    yield make
    with pg_conn.cursor() as cur:
        for name in created:
            cur.execute(f"DROP SCHEMA IF EXISTS {name} CASCADE")


@pytest.fixture(scope="session")
def pg_db(pg_conn):
    from memos.configs.project_db import PostgresProjectDBConfig
    from memos.project_dbs.postgres import PostgresProjectDB

    with pg_conn.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS project_memory CASCADE")
    kwargs = pg_kwargs()
    kwargs["db_name"] = kwargs.pop("dbname")
    # zhparser is usually not installed locally; the schema is the same with simple
    store = PostgresProjectDB(
        PostgresProjectDBConfig(**kwargs, text_search_parser="simple", embedding_dimension=DIM)
    )
    yield store
    store.close()


@pytest.fixture(params=["fake", "postgres"])
def db(request):
    if request.param == "fake":
        return FakeProjectDB()
    return request.getfixturevalue("pg_db")


def add_topic(db, space_id: str, domain: str) -> str:
    """Create a minimal topic with one decision through apply_changes."""
    from datetime import datetime, timezone

    from memos.project_dbs.item import Decision, TopicChangeSet, TopicCreate

    now = datetime.now(timezone.utc)
    (result,) = db.apply_changes(
        TopicChangeSet(
            space_id=space_id,
            accept_time=now,
            creates=[
                TopicCreate(
                    domain=domain,
                    topic_name="n",
                    topic_summary="s",
                    topic_description="d",
                    create_time=now,
                    update_time=now,
                    entries=[Decision(content="c", chat_time=now, user_ids=[])],
                )
            ],
        )
    )
    return result.topic_id
