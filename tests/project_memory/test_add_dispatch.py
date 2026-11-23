import json
import os

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_PROCESS_TASK_LABEL,
    PROJECT_ADD_SPACE_TASK_LABEL,
)
from memos.project_memory.add_dispatch import EpisodeDispatch
from memos.project_memory.add_store import PostgresAddStore


@pytest.fixture
def database():
    dsn = os.getenv("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required")
    store = PostgresAddStore(
        {"dsn": dsn, "schema_name": f"dispatch_{uuid4().hex}", "embedding_dimension": 3},
    )
    yield store
    with store.transaction() as cursor:
        from psycopg2 import sql

        cursor.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(store.schema_name)))
    store.close()


def test_recovery_fences_expired_work_and_duplicate_messages(database):
    now = datetime.now(timezone.utc)
    with database.transaction() as cur:
        cur.execute("INSERT INTO spaces (id, project_id, space_name) VALUES ('s', 'sample', 'S')")
        cur.execute(
            """INSERT INTO episodes (id, space_id, project_id, conversation_key, user_id,
                 domains, state, closed_at, opened_at, last_turn_at, stage)
               VALUES ('ep', 's', 'sample', 'conv', 'member', '{}', 'closed',
                       %s, %s, %s, 'extracting')""",
            (now, now, now),
        )

    dispatch = EpisodeDispatch(database, lease_seconds=2)
    process = ScheduleMessageItem(
        user_id="member",
        mem_cube_id="s",
        label=PROJECT_ADD_PROCESS_TASK_LABEL,
        content=json.dumps({"episode_id": "ep", "attempt": 0}),
    )
    assert [row["id"] for row in dispatch.due(now, stale_seconds=1)] == ["ep"]
    first = dispatch.claim(process, now)
    assert first is not None
    assert dispatch.claim(process, now) is None
    assert not dispatch.due(now, stale_seconds=1)
    after = now + timedelta(seconds=3)
    second = dispatch.claim(process, after)
    assert second is not None
    assert not dispatch.advance(first, after, stage="done", outcome="skipped")
    assert dispatch.advance(
        second, after, stage="organizing_queued", state="extracted", drafts=[{"kind": "decision"}]
    )
    assert dispatch.claim(process, after) is None

    organization = process.model_copy(update={"label": PROJECT_ADD_SPACE_TASK_LABEL})
    current = dispatch.claim(organization, after)
    assert current is not None
    assert current.attempt == 1
    assert dispatch.claim(organization, after) is None
