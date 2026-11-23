"""Receipt, Turn ownership, and closure for the project Add endpoint."""

from __future__ import annotations

import json
import os

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from memos.api.project_fields import PROJECT_MAX_SPACES, normalize_str_list

from .add_ingestion import AddRequestError as AddRequestError
from .add_ingestion import normalize_turns, task_boundary, turn_source
from .add_store import json_value, record_event


if TYPE_CHECKING:
    from collections.abc import Callable

    from .add_store import PostgresAddStore


@dataclass(frozen=True)
class AcceptanceSettings:
    idle_seconds: int = 15 * 60
    wait_seconds: int = 30 * 60
    max_turns: int = 8
    max_characters: int = 12_000 * 2

    def __post_init__(self) -> None:
        if min(self.idle_seconds, self.wait_seconds, self.max_turns, self.max_characters) <= 0:
            raise ValueError("Project memory Episode thresholds must be positive")

    @classmethod
    def from_env(cls) -> AcceptanceSettings:
        return cls(
            idle_seconds=int(os.getenv("PROJECT_MEMORY_EPISODE_IDLE_SECONDS", str(15 * 60))),
            wait_seconds=int(os.getenv("PROJECT_MEMORY_EPISODE_WAIT_SECONDS", str(30 * 60))),
            max_turns=int(os.getenv("PROJECT_MEMORY_EPISODE_MAX_TURNS", "8")),
            max_characters=2 * int(os.getenv("PROJECT_MEMORY_EPISODE_MAX_TOKENS", "12000")),
        )


@dataclass(frozen=True)
class AcceptedAdd:
    task_id: str
    closed_episode_ids: list[str]
    duplicate: bool = False


@dataclass(frozen=True)
class _Request:
    task_id: str
    user_id: str
    agent_id: Any
    conversation_id: str | None
    conversation_key: str
    now: datetime


class AddAcceptance:
    def __init__(
        self,
        store: PostgresAddStore,
        settings: AcceptanceSettings | None = None,
        clock: Callable[[], datetime] | None = None,
        *,
        anchor_collector: Callable[[list[dict], list[dict]], list[dict]] | None = None,
        anchor_keyer: Callable[[list[dict]], list[str]] | None = None,
    ) -> None:
        self.store = store
        self.settings = settings or AcceptanceSettings.from_env()
        self.clock = clock
        self.anchor_collector = anchor_collector
        self.anchor_keyer = anchor_keyer

    def accept(self, request: Any) -> AcceptedAdd:
        """Commit messages and ownership before handing any closed Episode to the scheduler."""
        project_id = getattr(request, "project_id", None)
        if project_id is not None and project_id != self.store.project_id:
            raise AddRequestError("SPACE_NOT_FOUND", "Project memory Space was not found", 404)
        user_id = request.user_id
        task_id = getattr(request, "task_id", None) or str(uuid4())
        try:
            spaces = normalize_str_list(getattr(request, "space_ids", None), "space_ids")
            domains = normalize_str_list(getattr(request, "domains", None), "domains")
        except (TypeError, ValueError) as exc:
            raise AddRequestError("INVALID_PARAMS", str(exc)) from exc
        if not isinstance(user_id, str) or not user_id.strip() or not spaces:
            raise AddRequestError("SCOPE_REQUIRED", "user_id and space_ids are required")
        if len(spaces) > PROJECT_MAX_SPACES:
            raise AddRequestError(
                "INVALID_PARAMS", f"space_ids accepts at most {PROJECT_MAX_SPACES} IDs"
            )
        conversation_id = getattr(request, "conversation_id", None) or getattr(
            request, "session_id", None
        )
        if conversation_id in ("", "default_session"):
            conversation_id = None
        if conversation_id and conversation_id.startswith("task:"):
            raise AddRequestError("INVALID_PARAMS", "conversation_id uses a reserved prefix")

        member_map = getattr(request, "project_member_map", None) or {}
        agent_id = getattr(request, "agent_id", None)
        if isinstance(agent_id, list):
            agent_id = [member_map.get(agent, agent) for agent in agent_id]
        elif isinstance(agent_id, str):
            agent_id = member_map.get(agent_id, agent_id)
        conversation_key = conversation_id or f"task:{task_id}"
        with self.store.transaction() as cursor:
            self._lock(cursor, "task", task_id)
            self._lock(cursor, "conversation", conversation_key)
            scopes = self._scopes(cursor, spaces, domains)
            now = self._now(cursor)
            ctx = _Request(task_id, user_id, agent_id, conversation_id, conversation_key, now)
            turns = normalize_turns(request.messages, task_id, user_id, member_map, now)
            owners = self._owners(cursor, ctx, spaces, turns)
            exact_replay = self._replayed_task(
                cursor, ctx, len(scopes), turns, owners, set(domains)
            )
            self._store_messages(cursor, ctx, turns)
            if exact_replay:
                return AcceptedAdd(exact_replay, [], duplicate=True)
            closed = []
            for space in scopes:
                new_turns = [
                    turn
                    for turn in turns
                    if (space["id"], turn_source(turn)["message_id"]) not in owners
                ]
                if new_turns:
                    closed.extend(self._append_space(cursor, ctx, space, new_turns))
            return AcceptedAdd(task_id, closed)

    def _lock(self, cursor: Any, key_type: str, key: str) -> None:
        lock_id = json.dumps([self.store.schema_name, self.store.project_id, key_type, key])
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (lock_id,))

    def _now(self, cursor: Any) -> datetime:
        if self.clock is not None:
            return self.clock()
        cursor.execute("SELECT clock_timestamp() AS current_time")
        return cursor.fetchone()["current_time"]

    def _scopes(self, cursor: Any, spaces: list[str], domains: list[str]) -> list[dict[str, Any]]:
        cursor.execute(
            """SELECT s.id, COALESCE(st.resource_bindings, '[]'::jsonb) AS resource_bindings,
                      ARRAY(SELECT domain FROM domains d WHERE d.space_id = s.id ORDER BY domain) AS domains
               FROM spaces s LEFT JOIN add_space_state st ON st.space_id = s.id
               WHERE s.project_id = %s AND s.id = ANY(%s::text[])
               ORDER BY s.id FOR SHARE OF s""",
            (self.store.project_id, spaces),
        )
        scopes = cursor.fetchall()
        if len(scopes) != len(spaces):
            raise AddRequestError("SPACE_NOT_FOUND", "Project memory Space was not found", 404)
        for scope in scopes:
            if not scope["domains"]:
                raise AddRequestError(
                    "SPACE_DOMAIN_NOT_CONFIGURED", "Space has no configured domains", 400
                )
            if set(domains) - set(scope["domains"]):
                raise AddRequestError(
                    "DOMAIN_NOT_REGISTERED", "Space does not contain every requested domain", 400
                )
            scope["domains"] = sorted(domains) if domains else scope["domains"]
        return scopes

    def _owners(
        self, cursor: Any, ctx: _Request, spaces: list[str], turns: list[list[dict[str, Any]]]
    ) -> dict[tuple[str, str], dict[str, Any]]:
        cursor.execute(
            """SELECT t.space_id, t.turn_id, t.task_id, t.user_id, e.domains
               FROM episode_turns t JOIN episodes e ON e.id = t.episode_id
               WHERE t.project_id = %s AND t.conversation_key = %s
                 AND t.space_id = ANY(%s::text[]) AND t.turn_id = ANY(%s::text[])""",
            (
                self.store.project_id,
                ctx.conversation_key,
                spaces,
                [turn_source(turn)["message_id"] for turn in turns],
            ),
        )
        return {(row["space_id"], row["turn_id"]): row for row in cursor.fetchall()}

    def _replayed_task(
        self,
        cursor: Any,
        ctx: _Request,
        space_count: int,
        turns: list[list[dict[str, Any]]],
        owners: dict[tuple[str, str], dict[str, Any]],
        explicit_domains: set[str],
    ) -> str | None:
        cursor.execute(
            """SELECT space_id, conversation_key, turn_id, user_id FROM episode_turns
               WHERE project_id = %s AND task_id = %s""",
            (self.store.project_id, ctx.task_id),
        )
        previous = cursor.fetchall()
        complete = len(owners) == space_count * len(turns)
        matched_tasks = {row["task_id"] for row in owners.values()}
        if previous:
            # A caller-supplied Task ID cannot authorize writes to a second request.
            request_owners = {
                (row["space_id"], row["turn_id"])
                for row in owners.values()
                if row["task_id"] == ctx.task_id
            }
            if not complete or any(
                row["conversation_key"] != ctx.conversation_key
                or row["user_id"] != ctx.user_id
                or (row["space_id"], row["turn_id"]) not in request_owners
                for row in previous
            ):
                raise AddRequestError(
                    "TASK_ID_CONFLICT", "task_id is already used by another request", 409
                )
        if not complete:
            return None
        if len(matched_tasks) != 1 or any(row["user_id"] != ctx.user_id for row in owners.values()):
            raise AddRequestError(
                "TASK_REPLAY_CONFLICT", "replay does not identify a single owned Task", 409
            )
        if explicit_domains and any(
            set(row["domains"]) != explicit_domains for row in owners.values()
        ):
            raise AddRequestError(
                "TASK_REPLAY_CONFLICT", "replay does not match the original domains", 409
            )
        return next(iter(matched_tasks))

    def _store_messages(
        self, cursor: Any, ctx: _Request, turns: list[list[dict[str, Any]]]
    ) -> None:
        source_ids = [message["message_id"] for turn in turns for message in turn]
        cursor.execute(
            """SELECT message_id, turn_id, content_sha256 FROM messages
               WHERE project_id = %s AND conversation_key = %s AND message_id = ANY(%s::text[])""",
            (self.store.project_id, ctx.conversation_key, source_ids),
        )
        stored = {row["message_id"]: row for row in cursor.fetchall()}
        cursor.execute(
            """SELECT COALESCE(MAX(turn_seq), 0) AS last_seq FROM messages
               WHERE project_id = %s AND conversation_key = %s""",
            (self.store.project_id, ctx.conversation_key),
        )
        turn_seq = cursor.fetchone()["last_seq"]
        for turn in turns:
            turn_id = turn_source(turn)["message_id"]
            already_stored = [message for message in turn if message["message_id"] in stored]
            if already_stored:
                self._validate_existing_turn(cursor, ctx, turn_id, turn, already_stored, stored)
                continue
            turn_seq += 1
            for msg_seq, message in enumerate(turn, 1):
                cursor.execute(
                    """INSERT INTO messages (
                        project_id, conversation_key, conversation_id, message_id, turn_id,
                        turn_seq, msg_seq, role, role_id, role_name, content, tool_calls,
                        tool_call_id, experience_notes, chat_time, accepted_at, task_id, user_id,
                        agent_id, content_sha256
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                              %s, %s, %s, %s, %s, %s)""",
                    (
                        self.store.project_id,
                        ctx.conversation_key,
                        ctx.conversation_id,
                        message["message_id"],
                        turn_id,
                        turn_seq,
                        msg_seq,
                        message["role"],
                        message["role_id"],
                        message["role_name"],
                        message["content"],
                        json_value(message["tool_calls"]),
                        message["tool_call_id"],
                        json_value(message["experience_notes"]),
                        message["chat_time"],
                        ctx.now,
                        ctx.task_id,
                        ctx.user_id,
                        json_value(ctx.agent_id),
                        message["content_sha256"],
                    ),
                )

    def _validate_existing_turn(
        self,
        cursor: Any,
        ctx: _Request,
        turn_id: str,
        turn: list[dict[str, Any]],
        already_stored: list[dict[str, Any]],
        stored: dict[str, dict[str, Any]],
    ) -> None:
        for message in already_stored:
            existing = stored[message["message_id"]]
            if (
                existing["content_sha256"] != message["content_sha256"]
                or existing["turn_id"] != turn_id
            ):
                raise AddRequestError(
                    "MESSAGE_ID_CONFLICT",
                    f"message {message['message_id']} conflicts with stored source",
                    409,
                )
        cursor.execute(
            """SELECT message_id FROM messages
               WHERE project_id = %s AND conversation_key = %s AND turn_id = %s
               ORDER BY msg_seq, message_id""",
            (self.store.project_id, ctx.conversation_key, turn_id),
        )
        if [row["message_id"] for row in cursor.fetchall()] != [
            message["message_id"] for message in turn
        ]:
            raise AddRequestError(
                "MESSAGE_ID_CONFLICT", f"Turn {turn_id} conflicts with stored source", 409
            )

    def _append_space(
        self, cursor: Any, ctx: _Request, space: dict[str, Any], turns: list[list[dict[str, Any]]]
    ) -> list[str]:
        cursor.execute(
            """SELECT id, domains, idle_due_at, max_wait_due_at, anchors, anchor_keys
               FROM episodes WHERE project_id = %s AND space_id = %s AND conversation_key = %s
                 AND state = 'open' FOR UPDATE""",
            (self.store.project_id, space["id"], ctx.conversation_key),
        )
        episode = cursor.fetchone()
        closed = []
        if episode:
            reason = self._due_reason(episode, ctx.now)
            if reason:
                closed.append(self._close(cursor, episode["id"], reason, ctx.now))
                episode = None
        count, size = self._current_volume(cursor, episode["id"]) if episode else (0, 0)
        for turn in turns:
            boundary = task_boundary(turn) if ctx.conversation_id else None
            if episode and (boundary == "switch" or episode["domains"] != space["domains"]):
                closed.append(self._close(cursor, episode["id"], "task_boundary", ctx.now))
                episode = None
            if episode is None:
                episode = self._open(cursor, ctx, space, turn_source(turn)["chat_time"])
                count, size = 0, 0
            count += 1
            size += self._record_turn(cursor, ctx, space, episode, turn, count)
            reason = None
            if ctx.conversation_id:
                if boundary == "end":
                    reason = "task_boundary"
                elif count >= self.settings.max_turns:
                    reason = "turn_count"
                elif size >= self.settings.max_characters:
                    reason = "volume"
            if reason:
                closed.append(self._close(cursor, episode["id"], reason, ctx.now))
                episode = None
        if episode and not ctx.conversation_id:
            closed.append(self._close(cursor, episode["id"], "no_conversation", ctx.now))
        return closed

    def _current_volume(self, cursor: Any, episode_id: str) -> tuple[int, int]:
        cursor.execute(
            """SELECT COUNT(DISTINCT et.turn_id) AS turns,
                      COALESCE(SUM(char_length(m.content) + COALESCE(char_length(m.tool_calls::text), 0)), 0) AS size
               FROM episode_turns et JOIN messages m USING (project_id, conversation_key, turn_id)
               WHERE et.project_id = %s AND et.episode_id = %s AND m.role <> 'system'""",
            (self.store.project_id, episode_id),
        )
        row = cursor.fetchone()
        return row["turns"], row["size"]

    def _open(
        self, cursor: Any, ctx: _Request, space: dict[str, Any], chat_time: datetime
    ) -> dict[str, Any]:
        project_id = self.store.project_id
        episode_id = str(uuid4())
        cursor.execute(
            """INSERT INTO episodes (id, project_id, space_id, conversation_key, conversation_id,
                                      user_id, domains, previous_episode_id, state, stage, opened_at,
                                      last_turn_at, idle_due_at, max_wait_due_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, (
                    SELECT e.id FROM episodes e JOIN spaces s ON s.id = e.space_id
                    WHERE e.project_id = %s AND e.space_id = %s AND e.conversation_key = %s
                      AND e.state <> 'open' AND (s.cleared_at IS NULL OR e.opened_at > s.cleared_at)
                      AND %s IS NOT NULL
                    ORDER BY e.closed_at DESC, e.opened_at DESC, e.id DESC LIMIT 1
               ), 'open', 'episode_open', %s, %s, %s, %s)
               RETURNING id, domains, anchors, anchor_keys, idle_due_at""",
            (
                episode_id,
                project_id,
                space["id"],
                ctx.conversation_key,
                ctx.conversation_id,
                ctx.user_id,
                space["domains"],
                project_id,
                space["id"],
                ctx.conversation_key,
                ctx.conversation_id,
                ctx.now,
                chat_time,
                ctx.now + timedelta(seconds=self.settings.idle_seconds),
                ctx.now + timedelta(seconds=self.settings.wait_seconds),
            ),
        )
        episode = cursor.fetchone()
        record_event(cursor, project_id, episode_id, "opened", ctx.now, stage="episode_open")
        return episode

    def _record_turn(
        self,
        cursor: Any,
        ctx: _Request,
        space: dict[str, Any],
        episode: dict[str, Any],
        turn: list[dict[str, Any]],
        position: int,
    ) -> int:
        first = turn_source(turn)
        cursor.execute(
            """INSERT INTO episode_turns (project_id, space_id, conversation_key, turn_id, episode_id,
                    turn_seq, message_count, task_id, user_id, agent_id, chat_time, accepted_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                self.store.project_id,
                space["id"],
                ctx.conversation_key,
                first["message_id"],
                episode["id"],
                position,
                len(turn),
                ctx.task_id,
                ctx.user_id,
                json_value(ctx.agent_id),
                first["chat_time"],
                ctx.now,
            ),
        )
        processing = [message for message in turn if message["role"] != "system"]
        anchor_input = [
            {**message, "conversation_key": ctx.conversation_key, "origin_task_id": ctx.task_id}
            for message in processing
        ]
        anchors = (
            self.anchor_collector(anchor_input, space["resource_bindings"])
            if self.anchor_collector
            else []
        )
        old_anchor_keys = set(episode["anchor_keys"])
        new_anchor_keys = set(self.anchor_keyer(anchors)) if self.anchor_keyer else set()
        suspect = bool(
            position > 1
            and old_anchor_keys
            and new_anchor_keys
            and old_anchor_keys.isdisjoint(new_anchor_keys)
            and ctx.now
            >= episode["idle_due_at"] - timedelta(seconds=self.settings.idle_seconds / 2)
        )
        if anchors:
            episode["anchors"] = [*episode["anchors"], *anchors]
            episode["anchor_keys"] = sorted(old_anchor_keys | new_anchor_keys)
        episode["idle_due_at"] = ctx.now + timedelta(seconds=self.settings.idle_seconds)
        cursor.execute(
            """UPDATE episodes SET idle_due_at = %s, last_turn_at = GREATEST(last_turn_at, %s),
                    anchors = %s, anchor_keys = %s, updated_at = %s,
                    suspected_boundary_turn_ids = suspected_boundary_turn_ids || %s::text[]
               WHERE project_id = %s AND id = %s""",
            (
                episode["idle_due_at"],
                max(message["chat_time"] for message in processing),
                json_value(episode["anchors"]),
                episode["anchor_keys"],
                ctx.now,
                [first["message_id"]] if suspect else [],
                self.store.project_id,
                episode["id"],
            ),
        )
        return sum(
            len(msg["content"]) + len(json.dumps(msg["tool_calls"], ensure_ascii=False))
            for msg in processing
        )

    @staticmethod
    def _due_reason(episode: dict[str, Any], now: datetime) -> str | None:
        deadlines = [
            (deadline, reason)
            for deadline, reason in (
                (episode["max_wait_due_at"], "max_wait"),
                (episode["idle_due_at"], "idle"),
            )
            if deadline
        ]
        if deadlines:
            deadline, reason = min(deadlines)
            if deadline <= now:
                return reason
        return None

    def _close(self, cursor: Any, episode_id: str, reason: str, now: datetime) -> str:
        cursor.execute(
            """UPDATE episodes SET state = 'closed', stage = 'extracting', close_reason = %s,
                                      closed_at = %s, updated_at = %s
               WHERE project_id = %s AND id = %s AND state = 'open'""",
            (reason, now, now, self.store.project_id, episode_id),
        )
        if cursor.rowcount == 1:
            record_event(
                cursor,
                self.store.project_id,
                episode_id,
                "closed",
                now,
                stage="extracting",
                detail={"reason": reason},
            )
        return episode_id

    def close_due(self, limit: int = 100) -> list[str]:
        with self.store.transaction() as cursor:
            now = self._now(cursor)
            cursor.execute(
                """SELECT id, idle_due_at, max_wait_due_at FROM episodes
                   WHERE project_id = %s AND state = 'open' AND LEAST(idle_due_at, max_wait_due_at) <= %s
                   ORDER BY LEAST(idle_due_at, max_wait_due_at), id LIMIT %s FOR UPDATE SKIP LOCKED""",
                (self.store.project_id, now, limit),
            )
            closed = []
            for episode in cursor.fetchall():
                reason = self._due_reason(episode, now)
                if reason:
                    closed.append(self._close(cursor, episode["id"], reason, now))
            return closed

    def status(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT t.conversation_key, t.turn_id, t.message_count, e.stage, e.outcome,
                          e.result, e.error
                   FROM episode_turns t JOIN episodes e ON e.id = t.episode_id
                   WHERE t.project_id = %s AND t.task_id = %s AND t.user_id = %s
                   ORDER BY t.accepted_at, e.id""",
                (self.store.project_id, task_id, user_id),
            )
            rows = cursor.fetchall()
        if not rows:
            return None
        status = "completed"
        if any(row["outcome"] == "pending" and row["stage"] != "episode_open" for row in rows):
            status = "in_progress"
        elif any(row["outcome"] == "failed" for row in rows):
            status = "failed"
        memory_ids = sorted(
            {topic for row in rows for topic in (row["result"] or {}).get("topic_ids", [])}
        )
        open_turn_counts = {
            (row["conversation_key"], row["turn_id"]): row["message_count"]
            for row in rows
            if row["stage"] == "episode_open"
        }
        project = {
            "memory_ids": memory_ids,
            "open_episode_messages": sum(open_turn_counts.values()),
        }
        if status == "failed":
            first_error = next((row["error"] for row in rows if row["error"]), None)
            if first_error:
                project["error"] = first_error
        return {
            "task_id": task_id,
            "status": status,
            "memory_views": {
                "added": 0,
                "updated": len(memory_ids),
                "deleted": 0,
                "project": project,
            },
        }
