"""Durable delivery state for the project memory Add stages.

The stage of an Episode is `add_jobs.stage` (episode_open, extracting, organizing,
awaiting_merge, committing, done). The spec's stage set has no queue or retry stages, so:

- an Episode waiting for an organize worker is stage `organizing` with
  `organize_result.queued = true`; claiming it starts a new processing round (attempt + 1);
- an Episode waiting to retry stays in the stage it will resume, with `next_retry_time` set;
  it is not delivered or claimed before that time;
- `organize_result.work` is the lease of the worker running the stage and
  `organize_result.dispatched_at` when the stage was last handed to the queue.

`advance` replaces the transient part of organize_result (everything but
add_store.PERSISTENT_KEYS); persistent keys change only through its `persist` argument.
"""

from __future__ import annotations

import json

from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_MERGE_RESULT_TASK_LABEL,
    PROJECT_ADD_MERGE_TASK_LABEL,
    PROJECT_ADD_PROCESS_TASK_LABEL,
    PROJECT_ADD_SPACE_TASK_LABEL,
)

from .add_store import (
    EPISODE_COLUMNS,
    EPISODE_FROM,
    KEEP_PERSISTENT,
    PERSISTENT_KEYS,
    episode_view,
    json_value,
    record_event,
)


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
    # Filled by EpisodeDispatch.advance: where this stage handed the Episode next.
    transition: dict[str, Any] = field(default_factory=dict, compare=False)


TERMINAL_OUTCOMES = ("committed", "staged", "skipped", "failed")
# add_jobs columns `advance` may set; `persist` and `episode` are handled apart.
_JOB_FIELDS = {"stage", "outcome", "attempt", "drafts", "error", "next_retry_time", "topic_ids"}
_JSON_FIELDS = {"drafts", "error"}
_EPISODE_FIELDS = {"episode_summary", "topic_id", "embedding"}


def label_for(episode: dict[str, Any]) -> str | None:
    """The queue label that runs the Episode's current stage; None when nothing is due."""
    if episode["outcome"] != "pending" or episode["stage"] == "episode_open":
        return None
    data = episode.get("organize_result") or {}
    stage = episode["stage"]
    if stage == "awaiting_merge":
        return (
            PROJECT_ADD_MERGE_RESULT_TASK_LABEL
            if "changeset" in data
            else PROJECT_ADD_MERGE_TASK_LABEL
        )
    return {
        "extracting": PROJECT_ADD_PROCESS_TASK_LABEL,
        "organizing": PROJECT_ADD_SPACE_TASK_LABEL,
        "committing": PROJECT_ADD_MERGE_RESULT_TASK_LABEL,
    }.get(stage)


class EpisodeDispatch:
    def __init__(self, store: PostgresAddStore, *, lease_seconds: int) -> None:
        self.store = store
        self.lease_seconds = lease_seconds

    def due(self, now: datetime, *, stale_seconds: int, limit: int = 100) -> list[dict[str, Any]]:
        """Closed Episodes whose stage is ready and not handed to the queue recently."""
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                f"""SELECT {EPISODE_COLUMNS} FROM {EPISODE_FROM}
                    WHERE j.outcome = 'pending' AND j.stage <> 'episode_open'
                      AND COALESCE(j.next_retry_time, '-infinity') <= %s
                      AND COALESCE((j.organize_result->'work'->>'until')::timestamptz,
                                   '-infinity') <= %s
                      AND COALESCE((j.organize_result->>'dispatched_at')::timestamptz,
                                   '-infinity') <= %s
                    ORDER BY COALESCE(j.next_retry_time, j.update_time), j.episode_id
                    LIMIT %s""",
                (now, now, now - timedelta(seconds=stale_seconds), limit),
            )
            return [episode_view(row) for row in cursor.fetchall()]

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
                f"""SELECT {EPISODE_COLUMNS} FROM {EPISODE_FROM}
                    WHERE j.episode_id = %s AND j.space_id = %s
                      AND j.user_id = %s AND j.attempt = %s FOR UPDATE OF j""",
                (episode_id, message.mem_cube_id, message.user_id, attempt),
            )
            row = cursor.fetchone()
            if row is None:
                return None
            episode = episode_view(row)
            if label_for(episode) != message.label:
                return None
            if episode["next_retry_time"] is not None and episode["next_retry_time"] > now:
                return None
            data = dict(episode["organize_result"])
            work = data.get("work")
            if work and work["until"] > now.isoformat():
                return None

            stage = episode["stage"]
            if stage == "organizing" and data.pop("queued", False):
                attempt += 1  # A new processing round; later writes are fenced by it.
            if message.label == PROJECT_ADD_MERGE_RESULT_TASK_LABEL:
                stage = "committing"
            data.pop("dispatched_at", None)
            token = uuid4().hex
            data["work"] = {
                "token": token,
                "until": (now + timedelta(seconds=self.lease_seconds)).isoformat(),
            }
            cursor.execute(
                f"""UPDATE add_jobs
                    SET stage = %s, attempt = %s,
                        organize_result = {KEEP_PERSISTENT} || %s::jsonb,
                        next_retry_time = NULL, update_time = %s
                    WHERE episode_id = %s""",
                (stage, attempt, list(PERSISTENT_KEYS), json_value(data), now, episode_id),
            )
            record_event(
                cursor,
                None,
                episode_id,
                "claimed",
                now,
                stage=stage,
                attempt=attempt,
                detail={"label": message.label, "token": token},
            )
        return StageLease(episode_id, attempt, token, stage, data)

    def advance(
        self,
        lease: StageLease,
        now: datetime,
        *,
        persist: dict[str, Any] | None = None,
        episode: dict[str, Any] | None = None,
        turns: list[tuple] | None = None,
        **fields: Any,
    ) -> bool:
        """Hand the Episode on if this lease still owns its stage.

        `fields` are add_jobs columns (stage, outcome, attempt, drafts, error, next_retry_time,
        topic_ids) plus `organize_result`, the new transient hand-off (default: the lease's,
        without the work lease). `persist` sets persistent organize_result keys; `episode` sets
        episodes columns (episode_summary, topic_id)."""
        from psycopg2 import sql

        unknown = set(fields) - _JOB_FIELDS - {"organize_result"}
        if unknown or set(episode or {}) - _EPISODE_FIELDS:
            raise ValueError(f"Unknown Episode fields: {sorted(unknown)}")
        data = fields.pop("organize_result", lease.data)
        transient = {
            key: value
            for key, value in data.items()
            if key not in ("work", "dispatched_at") and key not in PERSISTENT_KEYS
        }
        merged = {**transient, **(persist or {})}
        fields["update_time"] = now
        assignments = [sql.SQL("{} = %s").format(sql.Identifier(name)) for name in fields]
        assignments.append(sql.SQL("organize_result = " + KEEP_PERSISTENT + " || %s::jsonb"))
        values = [
            json_value(value) if name in _JSON_FIELDS else value for name, value in fields.items()
        ]
        values += [list(PERSISTENT_KEYS), json_value(merged)]
        with self.store.transaction() as cursor:
            cursor.execute(
                sql.SQL(
                    """UPDATE add_jobs SET {} WHERE episode_id = %s
                       AND stage = %s AND attempt = %s AND outcome = 'pending'
                       AND organize_result->'work'->>'token' = %s"""
                ).format(sql.SQL(", ").join(assignments)),
                (*values, lease.episode_id, lease.stage, lease.attempt, lease.token),
            )
            applied = cursor.rowcount == 1
            if applied and episode:
                columns = sql.SQL(", ").join(
                    sql.SQL("{} = %s").format(sql.Identifier(name)) for name in episode
                )
                cursor.execute(
                    sql.SQL("UPDATE episodes SET {} WHERE id = %s").format(columns),
                    (*episode.values(), lease.episode_id),
                )
            if applied and turns:
                cursor.executemany(
                    """INSERT INTO turns AS t (project_id, conversation_key, turn_id, msg_ids, content, embedding)
                       SELECT project_id, conversation_key, %s, %s, %s, %s::vector
                       FROM add_jobs WHERE episode_id = %s
                       ON CONFLICT (project_id, conversation_key, turn_id) DO UPDATE
                       SET msg_ids = EXCLUDED.msg_ids, content = EXCLUDED.content, embedding = EXCLUDED.embedding
                       WHERE t.msg_ids <@ EXCLUDED.msg_ids""",
                    [(*turn, lease.episode_id) for turn in turns],
                )
            error = fields.get("error") or (persist or {}).get("last_error") or {}
            retrying = fields.get("next_retry_time") is not None
            lease.transition.update(
                applied=applied,
                stage="retry_wait" if retrying else fields.get("stage", lease.stage),
                outcome=fields.get("outcome"),
                reason=error.get("reason") if isinstance(error, dict) else None,
            )
            if applied and fields.get("outcome") in TERMINAL_OUTCOMES:
                record_event(
                    cursor,
                    None,
                    lease.episode_id,
                    "finished",
                    now,
                    stage=fields.get("stage", lease.stage),
                    attempt=fields.get("attempt", lease.attempt),
                    detail={"outcome": fields["outcome"], "reason": lease.transition["reason"]},
                )
            return applied

    def published(
        self, episode: dict[str, Any], now: datetime, *, label: str | None = None
    ) -> None:
        """Record a submitted delivery and mark it dispatched if the stage has not moved on.

        `now` is taken before submission, so the event precedes the claim it leads to.
        """
        with self.store.transaction() as cursor:
            record_event(
                cursor,
                None,
                episode["id"],
                "published",
                now,
                stage=episode["stage"],
                attempt=episode["attempt"],
                detail={"label": label} if label else None,
            )
            cursor.execute(
                """UPDATE add_jobs SET organize_result = COALESCE(organize_result, '{}'::jsonb)
                          || jsonb_build_object('dispatched_at', %s::text)
                   WHERE episode_id = %s AND stage = %s AND attempt = %s
                     AND outcome = 'pending' AND organize_result->'work' IS NULL""",
                (now.isoformat(), episode["id"], episode["stage"], episode["attempt"]),
            )

    def settle_boundary(
        self,
        lease: StageLease,
        now: datetime,
        episode: dict[str, Any],
        boundary: dict[str, Any],
        segments: list[tuple[int, int]],
    ) -> list[str] | None:
        """Record the boundary judgment and split the Episode at its task starts, in one
        transaction and only while this lease owns the stage. The Episode keeps the first
        segment; each later one becomes a sibling Episode (same Space and conversation,
        chained previous_episode_id, only the Tasks and Turn events of its messages) that
        starts at extraction and is not judged again. Returns the sibling ids, or None when
        the lease is lost."""
        with self.store.transaction() as cursor:
            cursor.execute(
                """SELECT organize_result FROM add_jobs
                   WHERE episode_id = %s AND stage = %s AND attempt = %s
                     AND outcome = 'pending' AND organize_result->'work'->>'token' = %s
                   FOR UPDATE""",
                (lease.episode_id, lease.stage, lease.attempt, lease.token),
            )
            row = cursor.fetchone()
            if row is None:
                return None
            organize = row["organize_result"] or {}
            ranges = organize.get("task_ranges") or {}
            owners = organize.get("task_owners") or {}

            def restricted(start: int, end: int) -> tuple[dict, dict]:
                kept = {
                    task: [max(lo, start), min(hi, end)]
                    for task, (lo, hi) in ranges.items()
                    if lo <= end and hi >= start
                }
                return kept, {task: owners.get(task) or {} for task in kept}

            first_start, first_end = segments[0]
            task_ranges, task_owners = restricted(first_start, first_end)
            cursor.execute(
                """UPDATE add_jobs SET task_ids = %s, update_time = %s,
                          organize_result = organize_result || %s::jsonb
                    WHERE episode_id = %s""",
                (
                    list(task_ranges) or list(episode["task_ids"]),
                    now,
                    json_value(
                        {"boundary": boundary, "task_ranges": task_ranges,
                         "task_owners": task_owners}
                        if len(segments) > 1
                        else {"boundary": boundary}
                    ),
                    lease.episode_id,
                ),
            )  # fmt: skip
            if len(segments) == 1:
                return []
            times = {m["msg_seq"]: m["chat_time"] for m in episode["messages"]}
            turn_ids = {m["msg_seq"]: m["turn_id"] for m in episode["messages"]}

            def chat_times(start: int, end: int) -> tuple[Any, Any]:
                values = [times[seq] for seq in range(start, end + 1) if seq in times]
                return min(values), max(values)

            cursor.execute(
                """UPDATE episodes SET message_seq_end = %s, first_chat_time = %s,
                          last_chat_time = %s WHERE id = %s""",
                (first_end, *chat_times(first_start, first_end), lease.episode_id),
            )
            siblings: list[str] = []
            previous = lease.episode_id
            for start, end in segments[1:]:
                sibling = str(uuid4())
                task_ranges, task_owners = restricted(start, end)
                tasks = list(task_ranges) or list(episode["task_ids"])
                user = next(
                    (o.get("user_id") for o in task_owners.values() if o.get("user_id")),
                    episode["user_id"],
                )
                cursor.execute(
                    """INSERT INTO episodes (id, space_id, conversation_key, message_seq_start,
                           message_seq_end, previous_episode_id, first_chat_time,
                           last_chat_time, create_time)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (sibling, episode["space_id"], episode["conversation_key"], start, end,
                     previous, *chat_times(start, end), now),
                )  # fmt: skip
                sibling_result = {
                    "task_ranges": task_ranges,
                    "task_owners": task_owners,
                    "close": {"reason": "split", "at": now.isoformat()},
                    # A later segment is a switch: it does not continue the previous work.
                    "boundary": {
                        "starts": [0],
                        "continues_previous": False,
                        "judged": False,
                        "reasons": [],
                        "split_from": lease.episode_id,
                    },
                }
                cursor.execute(
                    """INSERT INTO add_jobs (episode_id, project_id, space_id, conversation_key,
                           user_id, task_ids, domains, stage, accept_time, organize_result,
                           update_time)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, 'extracting', %s, %s, %s)""",
                    (sibling, episode["project_id"], episode["space_id"],
                     episode["conversation_key"], user, tasks, episode["domains"],
                     episode["accept_time"], json_value(sibling_result), now),
                )  # fmt: skip
                moved = sorted({turn_ids[s] for s in range(start, end + 1) if s in turn_ids})
                cursor.execute(
                    """UPDATE add_episode_events SET episode_id = %s
                       WHERE episode_id = %s AND event = 'turn'
                         AND detail->>'turn_id' = ANY(%s::text[])""",
                    (sibling, lease.episode_id, moved),
                )
                for event, detail in (("opened", None), ("closed", {"reason": "split"})):
                    record_event(cursor, None, sibling, event, now, stage="extracting",
                                 detail=detail)  # fmt: skip
                siblings.append(sibling)
                previous = sibling
            # Episodes that followed the original now follow its last segment.
            cursor.execute(
                """UPDATE episodes SET previous_episode_id = %s
                   WHERE previous_episode_id = %s AND NOT (id = ANY(%s::text[]))""",
                (previous, lease.episode_id, siblings),
            )
            return siblings
