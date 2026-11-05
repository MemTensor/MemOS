"""Optional isolated native PostgreSQL fixture for Dream lifecycle tests."""

import os

from uuid import uuid4

import pytest

from memos.configs.graph_db import PostgresGraphDBConfig
from memos.graph_dbs.postgres import PostgresGraphDB


@pytest.fixture
def graph():
    dsn = os.environ.get("MEMOS_TEST_PG_DSN")
    if not dsn:
        pytest.skip("MEMOS_TEST_PG_DSN not configured")
    psycopg2 = pytest.importorskip("psycopg2")
    from psycopg2 import sql
    from psycopg2.extensions import parse_dsn

    settings = parse_dsn(dsn)
    schema = "dream_lifecycle_" + uuid4().hex
    config = PostgresGraphDBConfig(
        host=settings.get("host", "localhost"),
        port=int(settings.get("port", 5432)),
        user=settings["user"],
        password=settings.get("password", ""),
        db_name=settings["dbname"],
        schema_name=schema,
        user_name="cube-a",
        embedding_dimension=3,
    )
    backend = PostgresGraphDB(config)
    yield backend
    backend.close()
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
    conn.close()
