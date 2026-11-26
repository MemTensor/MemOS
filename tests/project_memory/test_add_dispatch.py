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
            """INSERT INTO episodes (id, space_id, conversation_key, message_seq_start,
                 message_seq_end, first_chat_time, last_chat_time)
               VALUES ('ep', 's', 'conv', 1, 1, %s, %s)""",
            (now, now),
        )
        cur.execute(
            """INSERT INTO add_jobs (episode_id, project_id, space_id, conversation_key, user_id,
                 task_ids, domains, stage, accept_time, organize_result)
               VALUES ('ep', 'sample', 's', 'conv', 'member', '{task}', '{}', 'extracting', %s,
                       '{"close": {"reason": "idle"}}')""",
            (now,),
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
        second,
        after,
        stage="organizing",
        drafts=[{"kind": "decision"}],
        organize_result={"queued": True},
        persist={"extraction": {"at": after.isoformat(), "status": "drafted"}},
    )
    assert dispatch.claim(process, after) is None
    (queued,) = dispatch.due(after, stale_seconds=1)
    assert queued["state"] == "extracted" and queued["close_reason"] == "idle"
    assert queued["organize_result"] == {"queued": True}

    organization = process.model_copy(update={"label": PROJECT_ADD_SPACE_TASK_LABEL})
    current = dispatch.claim(organization, after)
    assert current is not None
    assert current.attempt == 1
    assert dispatch.claim(organization, after) is None


def test_retry_waits_in_its_stage_until_the_retry_time(database):
    now = datetime.now(timezone.utc)
    with database.transaction() as cur:
        cur.execute("INSERT INTO spaces (id, project_id, space_name) VALUES ('s', 'sample', 'S')")
        cur.execute(
            """INSERT INTO episodes (id, space_id, conversation_key, message_seq_start,
                 message_seq_end, first_chat_time, last_chat_time)
               VALUES ('ep', 's', 'conv', 1, 1, %s, %s)""",
            (now, now),
        )
        cur.execute(
            """INSERT INTO add_jobs (episode_id, project_id, space_id, conversation_key, user_id,
                 task_ids, domains, stage, accept_time)
               VALUES ('ep', 'sample', 's', 'conv', 'member', '{task}', '{}', 'extracting', %s)""",
            (now,),
        )
    dispatch = EpisodeDispatch(database, lease_seconds=60)
    process = ScheduleMessageItem(
        user_id="member",
        mem_cube_id="s",
        label=PROJECT_ADD_PROCESS_TASK_LABEL,
        content=json.dumps({"episode_id": "ep", "attempt": 0}),
    )
    lease = dispatch.claim(process, now)
    later = now + timedelta(seconds=10)
    assert dispatch.advance(
        lease,
        now,
        next_retry_time=later,
        organize_result={**lease.data, "retries": 1},
        persist={"last_error": {"reason": "MODEL_UNAVAILABLE"}},
    )
    assert lease.transition["stage"] == "retry_wait"
    assert dispatch.due(now, stale_seconds=0) == []
    assert dispatch.claim(process, now) is None
    (row,) = dispatch.due(later, stale_seconds=0)
    assert row["stage"] == "extracting" and row["last_error"]["reason"] == "MODEL_UNAVAILABLE"
    assert dispatch.claim(process, later).data["retries"] == 1
