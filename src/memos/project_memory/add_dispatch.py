"""Durable delivery state for the project memory Add stages."""

from __future__ import annotations

import json

from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_MERGE_RESULT_TASK_LABEL,
    PROJECT_ADD_MERGE_TASK_LABEL,
    PROJECT_ADD_PROCESS_TASK_LABEL,
    PROJECT_ADD_SPACE_TASK_LABEL,
)

from .add_store import json_value


if TYPE_CHECKING:
    from datetime import datetime

    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem

    from .add_store import PostgresAddStore


@dataclass(frozen=True)
class StageLease:
    episode_id: str
    attempt: int
    token: str
    stage: str
    data: dict[str, Any]


_JSON_FIELDS = {"organize_result", "result", "drafts", "anchors", "warnings", "error", "last_error"}


def label_for(episode: dict[str, Any]) -> str | None:
    if episode["outcome"] != "pending" or episode["state"] == "open":
        return None
    data = episode.get("organize_result") or {}
    stage = episode["stage"]
    if stage == "retry_wait":
        stage = data.get("resume_stage")
    if stage == "awaiting_merge":
        return (
            PROJECT_ADD_MERGE_RESULT_TASK_LABEL
            if "changeset" in data
            else PROJECT_ADD_MERGE_TASK_LABEL
        )
    return {
        "extracting": PROJECT_ADD_PROCESS_TASK_LABEL,
        "organizing_queued": PROJECT_ADD_SPACE_TASK_LABEL,
        "organizing": PROJECT_ADD_SPACE_TASK_LABEL,
        "committing": PROJECT_ADD_MERGE_RESULT_TASK_LABEL,
    }.get(stage)


class EpisodeDispatch:
    def __init__(self, store: PostgresAddStore, *, lease_seconds: int) -> None:
        self.store = store
        self.lease_seconds = lease_seconds

    def due(self, now: datetime, *, stale_seconds: int, limit: int = 100) -> list[dict[str, Any]]:
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT * FROM episodes
                   WHERE project_id = %s AND outcome = 'pending' AND state <> 'open'
                     AND COALESCE(next_retry_at, '-infinity') <= %s
                     AND COALESCE((organize_result->'work'->>'until')::timestamptz, '-infinity') <= %s
                     AND COALESCE(dispatched_at, '-infinity') <= %s
                   ORDER BY COALESCE(next_retry_at, updated_at), id LIMIT %s""",
                (self.store.project_id, now, now, now - timedelta(seconds=stale_seconds), limit),
            )
            return cursor.fetchall()

    def claim(self, message: ScheduleMessageItem, now: datetime) -> StageLease | None:
        try:
            payload = json.loads(message.content)
        except ValueError:
            return None
        if not isinstance(payload, dict):
            return None
        episode_id = payload.get("episode_id")
        attempt = payload.get("attempt")
        if not isinstance(episode_id, str) or type(attempt) is not int:
            return None

        with self.store.transaction() as cursor:
            cursor.execute(
                """SELECT * FROM episodes
                   WHERE project_id = %s AND id = %s AND space_id = %s
                     AND user_id = %s AND attempt = %s FOR UPDATE""",
                (self.store.project_id, episode_id, message.mem_cube_id, message.user_id, attempt),
            )
            episode = cursor.fetchone()
            if episode is None or label_for(episode) != message.label:
                return None
            if episode["next_retry_at"] is not None and episode["next_retry_at"] > now:
                return None
            data = dict(episode["organize_result"] or {})
            work = data.get("work")
            if work and work["until"] > now.isoformat():
                return None

            stage = episode["stage"]
            if stage == "retry_wait":
                stage = data.pop("resume_stage")
            if stage == "organizing_queued":
                stage = "organizing"
                attempt += 1
            if message.label == PROJECT_ADD_MERGE_RESULT_TASK_LABEL:
                stage = "committing"
            state = episode["state"]
            if message.label == PROJECT_ADD_PROCESS_TASK_LABEL:
                state = "extracting"
            token = uuid4().hex
            data["work"] = {
                "token": token,
                "until": (now + timedelta(seconds=self.lease_seconds)).isoformat(),
            }
            cursor.execute(
                """UPDATE episodes
                   SET stage = %s, state = %s, attempt = %s, organize_result = %s,
                       next_retry_at = NULL, updated_at = %s
                   WHERE project_id = %s AND id = %s""",
                (stage, state, attempt, json_value(data), now, self.store.project_id, episode_id),
            )
        return StageLease(episode_id, attempt, token, stage, data)

    def advance(self, lease: StageLease, now: datetime, **fields: Any) -> bool:
        from psycopg2 import sql

        data = fields.get("organize_result", lease.data)
        fields["organize_result"] = {key: value for key, value in data.items() if key != "work"}
        fields["dispatched_at"] = None
        fields["updated_at"] = now
        assignments = sql.SQL(", ").join(
            sql.SQL("{} = %s").format(sql.Identifier(name)) for name in fields
        )
        values = [
            json_value(value) if name in _JSON_FIELDS else value for name, value in fields.items()
        ]
        with self.store.transaction() as cursor:
            cursor.execute(
                sql.SQL(
                    """UPDATE episodes SET {} WHERE project_id = %s AND id = %s
                       AND stage = %s AND attempt = %s AND outcome = 'pending'
                       AND organize_result->'work'->>'token' = %s"""
                ).format(assignments),
                (
                    *values,
                    self.store.project_id,
                    lease.episode_id,
                    lease.stage,
                    lease.attempt,
                    lease.token,
                ),
            )
            return cursor.rowcount == 1

    def published(self, episode: dict[str, Any], now: datetime) -> None:
        with self.store.transaction() as cursor:
            cursor.execute(
                """UPDATE episodes SET dispatched_at = %s
                   WHERE project_id = %s AND id = %s AND stage = %s AND attempt = %s
                     AND outcome = 'pending'
                     AND organize_result->'work' IS NULL""",
                (now, self.store.project_id, episode["id"], episode["stage"], episode["attempt"]),
            )
