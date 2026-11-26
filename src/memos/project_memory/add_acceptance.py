"""Receipt, Turn ownership, and closure for the project Add endpoint.

Acceptance is synchronous and model-free. Each message is stored once per conversation
(`messages`, keyed by project, conversation key and message id) with a conversation-wide
`msg_seq` assigned in arrival order; a replay with the same id and content keeps its seq and a
different content is MESSAGE_ID_CONFLICT. A Turn is a user message plus the non-user messages
after it. In each Space the Turns join the conversation's open Episode, a contiguous msg_seq
range (`episodes`) with its `add_jobs` row; the Task that sent them is recorded in
`add_jobs.task_ids` and its range in `organize_result.task_ranges`.

An Episode closes on budgets only: idle and maximum wait (close_due_time), Turn count, input
volume, a change of the domain set, a Turn that does not continue its range (another Space's
messages in between, or an older message), the end of a request without a conversation id, and
flush. Whether the member switched tasks is judged by the model before extraction
(add_boundary).
"""

from __future__ import annotations

import json
import os

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from memos.api.project_fields import PROJECT_MAX_SPACES, normalize_str_list

from .add_ingestion import AddRequestError as AddRequestError
from .add_ingestion import normalize_turns, turn_source
from .add_metrics import task_metrics
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
    project_id: str
    task_id: str
    user_id: str
    agent_id: str | None
    conversation_id: str | None
    conversation_key: str
    now: datetime


@dataclass
class _Turn:
    messages: list[dict[str, Any]]

    @property
    def source(self) -> dict[str, Any]:
        return turn_source(self.messages)

    @property
    def start(self) -> int:
        return self.messages[0]["msg_seq"]

    @property
    def end(self) -> int:
        return self.messages[-1]["msg_seq"]

    @property
    def chars(self) -> int:
        return sum(_chars(message) for message in self.messages if message["role"] != "system")


def _chars(message: dict[str, Any]) -> int:
    calls = message.get("tool_calls")
    return len(message.get("content") or "") + (
        len(json.dumps(calls, ensure_ascii=False)) if calls else 0
    )


def _first_agent(agent_id: Any) -> str | None:
    """messages.agent_id is text: the first of a list."""
    if isinstance(agent_id, list):
        agent_id = next((agent for agent in agent_id if isinstance(agent, str) and agent), None)
    return agent_id if isinstance(agent_id, str) and agent_id else None


class AddAcceptance:
    def __init__(
        self,
        store: PostgresAddStore,
        settings: AcceptanceSettings | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self.settings = settings or AcceptanceSettings.from_env()
        self.clock = clock

    def accept(self, request: Any) -> AcceptedAdd:
        """Commit messages and ownership before handing any closed Episode to the scheduler."""
        # project_id is optional: the project is the one the Spaces belong to. When the request
        # names a project, Spaces outside it are not found.
        requested_project = getattr(request, "project_id", None)
        if not isinstance(requested_project, str) or not requested_project.strip():
            requested_project = None
        else:
            requested_project = requested_project.strip()
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
            project_id = self._project(scopes, requested_project)
            now = self._now(cursor)
            ctx = _Request(
                project_id,
                task_id,
                user_id,
                _first_agent(agent_id),
                conversation_id,
                conversation_key,
                now,
            )
            raw_turns = normalize_turns(request.messages, task_id, user_id, member_map, now)
            stored = self._stored(cursor, ctx, raw_turns)
            owners = self._owners(cursor, ctx, spaces, raw_turns, stored)
            exact_replay = self._replayed_task(
                cursor, ctx, len(scopes), raw_turns, stored, owners, set(domains)
            )
            turns = self._store_messages(cursor, ctx, raw_turns, stored)
            if exact_replay:
                return AcceptedAdd(exact_replay, [], duplicate=True)
            closed = []
            for space in scopes:
                new_turns = [turn for turn in turns if (space["id"], turn.start) not in owners]
                if new_turns:
                    closed.extend(self._append_space(cursor, ctx, space, new_turns))
            return AcceptedAdd(task_id, closed)

    def _lock(self, cursor: Any, key_type: str, key: str) -> None:
        lock_id = json.dumps([self.store.schema_name, key_type, key])
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (lock_id,))

    def _now(self, cursor: Any) -> datetime:
        if self.clock is not None:
            return self.clock()
        cursor.execute("SELECT clock_timestamp() AS current_time")
        return cursor.fetchone()["current_time"]

    def _scopes(self, cursor: Any, spaces: list[str], domains: list[str]) -> list[dict[str, Any]]:
        cursor.execute(
            """SELECT s.id, s.project_id, s.resource_bindings,
                      ARRAY(SELECT domain FROM domains d WHERE d.space_id = s.id ORDER BY domain)
                      AS domains
               FROM spaces s WHERE s.id = ANY(%s::text[])
               ORDER BY s.id FOR SHARE OF s""",
            (spaces,),
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

    @staticmethod
    def _project(scopes: list[dict[str, Any]], requested: str | None) -> str:
        """The project the Spaces belong to; a request naming another project sees no Space."""
        projects = {scope["project_id"] for scope in scopes}
        if requested is not None and projects != {requested}:
            raise AddRequestError("SPACE_NOT_FOUND", "Project memory Space was not found", 404)
        if len(projects) != 1:
            raise AddRequestError("INVALID_PARAMS", "space_ids must belong to one project")
        return projects.pop()

    @staticmethod
    def _stored(
        cursor: Any, ctx: _Request, turns: list[list[dict[str, Any]]]
    ) -> dict[str, dict[str, Any]]:
        """Messages of this request already stored, checked against their content: a Turn is
        stored whole, with its messages in consecutive seqs, or not at all."""
        cursor.execute(
            """SELECT message_id, msg_seq, content_sha256 FROM messages
               WHERE project_id = %s AND conversation_key = %s AND message_id = ANY(%s::text[])""",
            (
                ctx.project_id,
                ctx.conversation_key,
                [message["message_id"] for turn in turns for message in turn],
            ),
        )
        stored = {row["message_id"]: row for row in cursor.fetchall()}
        for turn in turns:
            found = [message for message in turn if message["message_id"] in stored]
            for message in found:
                if stored[message["message_id"]]["content_sha256"] != message["content_sha256"]:
                    raise AddRequestError(
                        "MESSAGE_ID_CONFLICT",
                        f"message {message['message_id']} conflicts with stored source",
                        409,
                    )
            if not found:
                continue
            seqs = [stored.get(message["message_id"], {}).get("msg_seq") for message in turn]
            first = seqs[0]
            if first is None or seqs != list(range(first, first + len(turn))):
                raise AddRequestError(
                    "MESSAGE_ID_CONFLICT",
                    f"Turn {turn_source(turn)['message_id']} conflicts with stored source",
                    409,
                )
        return stored

    @staticmethod
    def _owners(
        cursor: Any,
        ctx: _Request,
        spaces: list[str],
        turns: list[list[dict[str, Any]]],
        stored: dict[str, dict[str, Any]],
    ) -> dict[tuple[str, int], dict[str, Any]]:
        """(space, first seq of a stored Turn) -> the Task that put it in that Space's Episode."""
        starts = [
            stored[turn[0]["message_id"]]["msg_seq"]
            for turn in turns
            if turn[0]["message_id"] in stored
        ]
        if not starts:
            return {}
        cursor.execute(
            """SELECT e.space_id, e.message_seq_start, e.message_seq_end, j.domains, j.task_ids,
                      j.organize_result->'task_ranges' AS task_ranges,
                      j.organize_result->'task_owners' AS task_owners
               FROM episodes e JOIN add_jobs j ON j.episode_id = e.id
               WHERE j.project_id = %s AND e.conversation_key = %s
                 AND e.space_id = ANY(%s::text[])
                 AND int8range(e.message_seq_start, e.message_seq_end, '[]')
                     && int8range(%s, %s, '[]')""",
            (ctx.project_id, ctx.conversation_key, spaces, min(starts), max(starts)),
        )
        owners = {}
        for row in cursor.fetchall():
            ranges = row["task_ranges"] or {}
            for seq in starts:
                if not row["message_seq_start"] <= seq <= row["message_seq_end"]:
                    continue
                task = next(
                    (t for t, (lo, hi) in ranges.items() if lo <= seq <= hi), row["task_ids"][0]
                )
                owners[(row["space_id"], seq)] = {
                    "task_id": task,
                    "user_id": ((row["task_owners"] or {}).get(task) or {}).get("user_id"),
                    "domains": row["domains"],
                }
        return owners

    @staticmethod
    def _replayed_task(
        cursor: Any,
        ctx: _Request,
        space_count: int,
        turns: list[list[dict[str, Any]]],
        stored: dict[str, dict[str, Any]],
        owners: dict[tuple[str, int], dict[str, Any]],
        explicit_domains: set[str],
    ) -> str | None:
        """The original Task when this request replays one exactly; a Task id already used
        for other messages is a conflict."""
        cursor.execute(
            """SELECT space_id, conversation_key,
                      organize_result->'task_ranges'->%s AS task_range,
                      organize_result->'task_owners'->%s->>'user_id' AS user_id
               FROM add_jobs WHERE project_id = %s AND task_ids @> ARRAY[%s]::text[]""",
            (ctx.task_id, ctx.task_id, ctx.project_id, ctx.task_id),
        )
        previous = cursor.fetchall()
        complete = len(owners) == space_count * len(turns)
        matched_tasks = {row["task_id"] for row in owners.values()}
        if previous:
            # A caller-supplied Task ID cannot authorize writes to a second request.
            request_seqs = {row["msg_seq"] for row in stored.values()}
            own_spaces = {
                space for (space, _), row in owners.items() if row["task_id"] == ctx.task_id
            }
            if not complete or any(
                row["conversation_key"] != ctx.conversation_key
                or row["user_id"] != ctx.user_id
                or row["space_id"] not in own_spaces
                or not row["task_range"]
                or not set(range(row["task_range"][0], row["task_range"][1] + 1)) <= request_seqs
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

    @staticmethod
    def _store_messages(
        cursor: Any,
        ctx: _Request,
        turns: list[list[dict[str, Any]]],
        stored: dict[str, dict[str, Any]],
    ) -> list[_Turn]:
        """Insert the new messages with the next seqs of the conversation, in arrival order;
        stored ones keep theirs. Returns the request's Turns with seqs."""
        cursor.execute(
            """SELECT COALESCE(MAX(msg_seq), 0) AS last_seq FROM messages
               WHERE project_id = %s AND conversation_key = %s""",
            (ctx.project_id, ctx.conversation_key),
        )
        seq = cursor.fetchone()["last_seq"]
        out = []
        for turn in turns:
            rows = []
            for message in turn:
                row = dict(message)
                rows.append(row)
                if message["message_id"] in stored:
                    row["msg_seq"] = stored[message["message_id"]]["msg_seq"]
                    continue
                seq += 1
                row["msg_seq"] = seq
                cursor.execute(
                    """INSERT INTO messages (
                        project_id, conversation_key, message_id, msg_seq, role, role_id,
                        role_name, agent_id, content, tool_calls, tool_call_id, chat_time,
                        accept_time, task_id, experience_notes, content_sha256
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        ctx.project_id,
                        ctx.conversation_key,
                        message["message_id"],
                        seq,
                        message["role"],
                        message["role_id"],
                        message["role_name"],
                        ctx.agent_id,
                        message["content"],
                        json_value(message["tool_calls"]),
                        message["tool_call_id"],
                        message["chat_time"],
                        ctx.now,
                        ctx.task_id,
                        json_value(message["experience_notes"]),
                        message["content_sha256"],
                    ),
                )
            out.append(_Turn(rows))
        return out

    def _append_space(
        self, cursor: Any, ctx: _Request, space: dict[str, Any], turns: list[_Turn]
    ) -> list[str]:
        cursor.execute(
            """SELECT j.episode_id AS id, j.domains, j.accept_time, j.close_due_time,
                      e.message_seq_start, e.message_seq_end
               FROM add_jobs j JOIN episodes e ON e.id = j.episode_id
               WHERE j.project_id = %s AND j.space_id = %s AND j.conversation_key = %s
                 AND j.stage = 'episode_open' FOR UPDATE OF j""",
            (ctx.project_id, space["id"], ctx.conversation_key),
        )
        episode = cursor.fetchone()
        closed = []
        if episode:
            reason = self._due_reason(episode, ctx.now)
            if reason:
                closed.append(self._close(cursor, episode["id"], reason, ctx.now))
                episode = None
        count, size = self._current_volume(cursor, ctx, episode) if episode else (0, 0)
        for turn in turns:
            if episode:
                reason = None
                if episode["domains"] != space["domains"]:
                    reason = "domain_change"
                elif turn.start != episode["message_seq_end"] + 1:
                    reason = "interleaved"
                if reason:
                    closed.append(self._close(cursor, episode["id"], reason, ctx.now))
                    episode = None
            if episode is None:
                episode = self._open(cursor, ctx, space, turn)
                count, size = 0, 0
            else:
                self._extend(cursor, ctx, episode, turn)
            count += 1
            size += turn.chars
            self._turn_event(cursor, ctx, episode["id"], turn)
            reason = None
            if ctx.conversation_id:
                if count >= self.settings.max_turns:
                    reason = "turn_count"
                elif size >= self.settings.max_characters:
                    reason = "volume"
            if reason:
                closed.append(self._close(cursor, episode["id"], reason, ctx.now))
                episode = None
        if episode and not ctx.conversation_id:
            closed.append(self._close(cursor, episode["id"], "no_conversation", ctx.now))
        return closed

    @staticmethod
    def _current_volume(cursor: Any, ctx: _Request, episode: dict[str, Any]) -> tuple[int, int]:
        """Turns (user messages) and input size of the open Episode's range."""
        cursor.execute(
            """SELECT COUNT(*) FILTER (WHERE role = 'user') AS turns,
                      COALESCE(SUM(char_length(content)
                                   + COALESCE(char_length(tool_calls::text), 0)), 0) AS size
               FROM messages
               WHERE project_id = %s AND conversation_key = %s AND role <> 'system'
                 AND msg_seq BETWEEN %s AND %s""",
            (
                ctx.project_id,
                ctx.conversation_key,
                episode["message_seq_start"],
                episode["message_seq_end"],
            ),
        )
        row = cursor.fetchone()
        return max(1, row["turns"]), row["size"]

    def _close_due(self, ctx: _Request, accept_time: datetime) -> datetime:
        return min(
            ctx.now + timedelta(seconds=self.settings.idle_seconds),
            accept_time + timedelta(seconds=self.settings.wait_seconds),
        )

    def _open(
        self, cursor: Any, ctx: _Request, space: dict[str, Any], turn: _Turn
    ) -> dict[str, Any]:
        episode_id = str(uuid4())
        times = [message["chat_time"] for message in turn.messages]
        # reopen: the latest closed Episode of this Space and conversation since the last clear.
        cursor.execute(
            """INSERT INTO episodes (id, space_id, conversation_key, message_seq_start,
                                     message_seq_end, previous_episode_id, first_chat_time,
                                     last_chat_time, create_time)
               VALUES (%s, %s, %s, %s, %s, (
                    SELECT e.id FROM episodes e
                      JOIN add_jobs j ON j.episode_id = e.id
                      JOIN spaces s ON s.id = e.space_id
                    WHERE e.space_id = %s AND e.conversation_key = %s
                      AND j.stage <> 'episode_open'
                      AND (s.clear_time IS NULL OR e.create_time > s.clear_time)
                      AND e.message_seq_end < %s AND %s
                    ORDER BY e.message_seq_end DESC LIMIT 1
               ), %s, %s, %s)""",
            (
                episode_id,
                space["id"],
                ctx.conversation_key,
                turn.start,
                turn.end,
                space["id"],
                ctx.conversation_key,
                turn.start,
                ctx.conversation_id is not None,
                min(times),
                max(times),
                ctx.now,
            ),
        )
        organize = {
            "task_ranges": {ctx.task_id: [turn.start, turn.end]},
            "task_owners": {
                ctx.task_id: {"user_id": ctx.user_id, "accepted_at": ctx.now.isoformat()}
            },
        }
        close_due = self._close_due(ctx, ctx.now)
        cursor.execute(
            """INSERT INTO add_jobs (episode_id, project_id, space_id, conversation_key, user_id,
                                     task_ids, domains, stage, accept_time, close_due_time,
                                     organize_result, update_time)
               VALUES (%s, %s, %s, %s, %s, %s, %s, 'episode_open', %s, %s, %s, %s)""",
            (
                episode_id,
                ctx.project_id,
                space["id"],
                ctx.conversation_key,
                ctx.user_id,
                [ctx.task_id],
                space["domains"],
                ctx.now,
                close_due,
                json_value(organize),
                ctx.now,
            ),
        )
        record_event(cursor, ctx.project_id, episode_id, "opened", ctx.now, stage="episode_open")
        return {
            "id": episode_id,
            "domains": space["domains"],
            "accept_time": ctx.now,
            "close_due_time": close_due,
            "message_seq_start": turn.start,
            "message_seq_end": turn.end,
        }

    def _extend(self, cursor: Any, ctx: _Request, episode: dict[str, Any], turn: _Turn) -> None:
        times = [message["chat_time"] for message in turn.messages]
        cursor.execute(
            """UPDATE episodes SET message_seq_end = %s,
                      last_chat_time = GREATEST(last_chat_time, %s),
                      first_chat_time = LEAST(first_chat_time, %s)
               WHERE id = %s""",
            (turn.end, max(times), min(times), episode["id"]),
        )
        episode["message_seq_end"] = turn.end
        episode["close_due_time"] = self._close_due(ctx, episode["accept_time"])
        owner = {"user_id": ctx.user_id, "accepted_at": ctx.now.isoformat()}
        cursor.execute(
            """UPDATE add_jobs SET
                  task_ids = CASE WHEN task_ids @> ARRAY[%(task)s]::text[] THEN task_ids
                                  ELSE task_ids || ARRAY[%(task)s]::text[] END,
                  organize_result = jsonb_set(jsonb_set(
                      organize_result, ARRAY['task_ranges', %(task)s],
                      jsonb_build_array(COALESCE(
                          (organize_result->'task_ranges'->%(task)s->>0)::bigint, %(start)s),
                          %(end)s::bigint)),
                      ARRAY['task_owners', %(task)s],
                      COALESCE(organize_result->'task_owners'->%(task)s, %(owner)s::jsonb)),
                  close_due_time = %(due)s, update_time = %(now)s
               WHERE episode_id = %(id)s""",
            {
                "task": ctx.task_id,
                "start": turn.start,
                "end": turn.end,
                "owner": json.dumps(owner),
                "due": episode["close_due_time"],
                "now": ctx.now,
                "id": episode["id"],
            },
        )

    @staticmethod
    def _turn_event(cursor: Any, ctx: _Request, episode_id: str, turn: _Turn) -> None:
        # The Turn's input size weighs this Task's share of the Episode's model usage.
        record_event(
            cursor,
            None,
            episode_id,
            "turn",
            ctx.now,
            stage="episode_open",
            detail={
                "task_id": ctx.task_id,
                "turn_id": turn.source["message_id"],
                "chars": turn.chars,
            },
        )

    def _due_reason(self, episode: dict[str, Any], now: datetime) -> str | None:
        if episode["close_due_time"] is None or episode["close_due_time"] > now:
            return None
        waited = episode["accept_time"] + timedelta(seconds=self.settings.wait_seconds)
        return "max_wait" if waited <= now else "idle"

    @staticmethod
    def _close(cursor: Any, episode_id: str, reason: str, now: datetime) -> str:
        cursor.execute(
            """UPDATE add_jobs SET stage = 'extracting', close_due_time = NULL,
                      organize_result = COALESCE(organize_result, '{}'::jsonb)
                          || jsonb_build_object('close',
                                 jsonb_build_object('reason', %s::text, 'at', %s::text)),
                      update_time = %s
               WHERE episode_id = %s AND stage = 'episode_open'""",
            (reason, now.isoformat(), now, episode_id),
        )
        if cursor.rowcount == 1:
            record_event(
                cursor,
                None,
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
                """SELECT episode_id AS id, accept_time, close_due_time FROM add_jobs
                   WHERE stage = 'episode_open' AND close_due_time <= %s
                   ORDER BY close_due_time, episode_id LIMIT %s FOR UPDATE SKIP LOCKED""",
                (now, limit),
            )
            closed = []
            for episode in cursor.fetchall():
                reason = self._due_reason(episode, now)
                if reason:
                    closed.append(self._close(cursor, episode["id"], reason, now))
            return closed

    def close_open(self, space_id: str, conversation_id: str | None = None) -> list[str]:
        """Close a Space's open Episodes now, as if they had gone idle (flush)."""
        with self.store.transaction() as cursor:
            now = self._now(cursor)
            cursor.execute(
                """SELECT episode_id FROM add_jobs
                   WHERE space_id = %s AND stage = 'episode_open'
                     AND (%s::text IS NULL OR conversation_key = %s)
                   ORDER BY accept_time, episode_id FOR UPDATE SKIP LOCKED""",
                (space_id, conversation_id, conversation_id),
            )
            return [
                self._close(cursor, row["episode_id"], "idle", now) for row in cursor.fetchall()
            ]

    def status(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT project_id, conversation_key, stage, outcome, topic_ids, error,
                          organize_result->'task_ranges'->%s AS task_range
                   FROM add_jobs
                   WHERE task_ids @> ARRAY[%s]::text[]
                     AND organize_result->'task_owners'->%s->>'user_id' = %s
                   ORDER BY accept_time, episode_id""",
                (task_id, task_id, task_id, user_id),
            )
            rows = cursor.fetchall()
            if not rows:
                return None
            metrics = task_metrics(cursor, rows[0]["project_id"], task_id, user_id)
        status = "completed"
        if any(row["outcome"] == "pending" and row["stage"] != "episode_open" for row in rows):
            status = "in_progress"
        elif any(row["outcome"] == "failed" for row in rows):
            status = "failed"
        memory_ids = sorted({topic for row in rows for topic in row["topic_ids"] or []})
        # A message accepted into several Spaces counts once.
        open_messages = {
            (row["conversation_key"], seq)
            for row in rows
            if row["stage"] == "episode_open" and row["task_range"]
            for seq in range(row["task_range"][0], row["task_range"][1] + 1)
        }
        project = {
            "memory_ids": memory_ids,
            "open_episode_messages": len(open_messages),
            # Timing and attributed model usage; completed_at stays null while an Episode is open.
            "metrics": metrics,
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
