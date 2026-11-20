"""Fixtures for project_dbs tests.

``db`` runs each contract test against the in-memory fake and, when
PROJECT_DB_TEST_HOST is set, against a real PostgreSQL + pgvector, e.g.
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg17

WARNING: the PostgreSQL run drops and recreates the schema ``project_memory``
in the target database (PROJECT_DB_TEST_NAME, default ``postgres``).
"""

import os
import uuid

import pytest

from tests.project_dbs.fake import FakeProjectDB


HOST = os.getenv("PROJECT_DB_TEST_HOST")


@pytest.fixture(scope="session")
def pg_db():
    if not HOST:
        pytest.skip("PROJECT_DB_TEST_HOST not set")
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
    # zhparser is usually not installed locally; the schema is the same with simple
    store = PostgresProjectDB(PostgresProjectDBConfig(**kwargs, text_search_parser="simple"))
    yield store
    store.close()


@pytest.fixture(params=["fake", "postgres"])
def db(request):
    if request.param == "fake":
        return FakeProjectDB()
    return request.getfixturevalue("pg_db")


def add_topic(db, space_id: str, domain: str) -> str:
    """Insert a minimal topic (plus one entry on PostgreSQL) without the topic API."""
    domain_id = next(d.id for d in db.list_domains(space_id) if d.domain == domain)
    topic_id = f"topic_{uuid.uuid4().hex}"
    if isinstance(db, FakeProjectDB):
        db._topics[topic_id] = {"space_id": space_id, "domain_id": domain_id}
        return topic_id
    with db._tx() as cur:
        cur.execute(
            """INSERT INTO project_memory.topics
                   (id, space_id, domain_id, topic_name, topic_summary, topic_description)
               VALUES (%s, %s, %s, 'n', 's', 'd')""",
            (topic_id, space_id, domain_id),
        )
        cur.execute(
            """INSERT INTO project_memory.project_entries
                   (id, topic_id, space_id, entry_type, content, time)
               VALUES (%s, %s, %s, 'decision', 'c', now())""",
            (f"decision_{uuid.uuid4().hex}", topic_id, space_id),
        )
    return topic_id
