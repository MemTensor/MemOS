"""Replay FrontierMemory Turns through the project's Add runtime in a local database."""

from __future__ import annotations

import argparse
import ipaddress
import json
import logging
import os
import subprocess
import sys
import time

from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from itertools import groupby
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit
from uuid import uuid4

from memos.project_memory.add_runtime import EpisodeAddRuntime, RuntimeSettings
from memos.project_memory.add_store import PostgresAddStore
from memos.project_memory.judge import ModelHub


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


SPACE = "frontier-pilot"
DOMAIN = "engineering"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
MAX_WORK_GROUPS = 50


def validate_work_limit(turns: list[dict[str, Any]]) -> int:
    """Count gold work groups and enforce the experimental sample cap before replay."""
    groups = set()
    for turn in turns:
        label = turn.get("gold_work")
        if not isinstance(label, str) or not label.strip():
            raise ValueError("Each Turn must have a concrete gold_work label")
        groups.add(label)
    if len(groups) > MAX_WORK_GROUPS:
        raise ValueError(f"Replay is limited to {MAX_WORK_GROUPS} concrete work groups")
    return len(groups)


def request_for_turn(turn: dict[str, Any]) -> SimpleNamespace:
    """Build an ordinary Add request without including benchmark annotations."""
    messages = turn["messages"]
    if (
        not messages
        or messages[0]["role"] != "user"
        or messages[0]["message_id"] != turn["turn_id"]
        or any(message["role"] != "assistant" for message in messages[1:])
    ):
        raise ValueError("Expected one Turn with a user message ID matching turn_id")
    return SimpleNamespace(
        user_id=turn["user_id"],
        conversation_id=turn["conversation_id"],
        task_id=turn["turn_id"],
        space_ids=[SPACE],
        domains=[DOMAIN],
        messages=[
            {key: message[key] for key in ("message_id", "role", "content")} for message in messages
        ],
    )


def witness_index(
    topics: list[dict[str, Any]], message_turns: dict[str, str]
) -> dict[str, set[str]]:
    """Map source references in persisted Topic entries back to individual Turns."""
    index: dict[str, set[str]] = defaultdict(set)
    for topic in topics:
        for field in ("decisions", "experiences", "timeline"):
            pending = list(topic.get(field) or [])
            while pending:
                node = pending.pop()
                if isinstance(node, list):
                    pending.extend(node)
                elif isinstance(node, dict):
                    for turn_id in node.get("turn_ids") or []:
                        index[turn_id].add(topic["id"])
                    if (turn_id := message_turns.get(node.get("message_id"))) is not None:
                        index[turn_id].add(topic["id"])
                    pending.extend(
                        value for value in node.values() if isinstance(value, list | dict)
                    )
    return dict(index)


def observe_turn(
    row: dict[str, Any], live_topic_ids: set[str], witnesses: dict[str, set[str]]
) -> dict[str, Any]:
    """Resolve final membership even when a later Formation moved a staged Episode."""
    result = row.get("result") or {}
    targets = set(result.get("topic_ids") or [])
    staged_status = row.get("staged_status")
    if staged_status == "moved" and (destination := row.get("moved_to_topic_id")):
        targets.add(destination)
    if missing_topics := targets - live_topic_ids:
        raise ValueError(f"Episode references absent Topic IDs: {sorted(missing_topics)}")
    outcome = row["outcome"]
    status = {
        "failed": "failed",
        "pending": "pending",
        "skipped": "no_drafts",
    }.get(outcome, "unassigned")
    if targets:
        status = "assigned"
    elif staged_status == "active":
        status = "staged"
    error = row.get("error") or {}
    return {
        "turn_id": row["turn_id"],
        "episode_id": row["episode_id"],
        "topic_ids": sorted(targets),
        "witness_topic_ids": sorted(witnesses.get(row["turn_id"], set())),
        "status": status,
        "outcome": outcome,
        "close_reason": row.get("close_reason"),
        "extract_status": row.get("extract_status"),
        "draft_count": len(row.get("drafts") or []),
        "draft_kinds": [draft["kind"] for draft in row.get("drafts") or []],
        "episode_summary": row.get("episode_summary"),
        "staged_status": staged_status,
        "staged_reason": row.get("staged_reason"),
        "reason": error.get("reason") or error.get("code"),
        "warnings": result.get("warnings") or [],
    }


@dataclass
class ReplayClock:
    current: datetime

    def __call__(self) -> datetime:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += timedelta(seconds=seconds)


def drain_work(
    runtime: EpisodeAddRuntime, queue: deque[ScheduleMessageItem], clock: ReplayClock, ledger: Any
) -> None:
    """Drain the actual scheduler stage callbacks, advancing time for deferred retries."""
    for _ in range(1000):
        ledger.ensure_open()
        if queue:
            runtime.handle([queue.popleft()])
            continue
        runtime.recover()
        if queue:
            continue
        with runtime.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT MIN(GREATEST(
                              updated_at, COALESCE(next_retry_at, '-infinity'),
                              COALESCE((organize_result->'work'->>'until')::timestamptz, '-infinity'),
                              COALESCE(dispatched_at + %s * interval '1 second', '-infinity')
                          )) AS next_at
                   FROM episodes
                   WHERE project_id = %s AND outcome = 'pending' AND state <> 'open'""",
                (runtime.settings.publish_stale_seconds, runtime.store.project_id),
            )
            next_at = cursor.fetchone()["next_at"]
        if next_at is None:
            return
        clock.advance(max(1, (next_at - clock()).total_seconds() + 1))
    raise RuntimeError("Add replay exceeded its scheduler recovery limit")


def export_state(store: PostgresAddStore, turns: list[dict[str, Any]]) -> dict[str, Any]:
    """Read persisted Turn, Episode and Topic assignments from the isolated store."""
    topics = store.read_topics(SPACE)
    live_topic_ids = {topic["id"] for topic in topics}
    message_turns = {
        message["message_id"]: turn["turn_id"] for turn in turns for message in turn["messages"]
    }
    witnesses = witness_index(topics, message_turns)
    with store.transaction(readonly=True) as cursor:
        cursor.execute(
            """SELECT et.turn_id, et.episode_id, e.outcome, e.result, e.close_reason,
                      e.extract_status, e.drafts, e.episode_summary, e.staged_status,
                      e.staged_reason, e.moved_to_topic_id, e.error
               FROM episode_turns et JOIN episodes e ON e.id = et.episode_id
               WHERE et.project_id = %s AND et.space_id = %s""",
            (store.project_id, SPACE),
        )
        observations = {
            row["turn_id"]: observe_turn(row, live_topic_ids, witnesses)
            for row in cursor.fetchall()
        }
    order = [turn["turn_id"] for turn in turns]
    if set(observations) - set(order):
        raise ValueError("Unexpected Turns in isolated replay schema")
    return {
        "turns": [observations[turn_id] for turn_id in order if turn_id in observations],
        "topics": [
            {
                "topic_id": topic["id"],
                "name": topic["topic_name"],
                "summary": topic["topic_summary"],
                "description": topic["topic_description"],
                "entry_counts": {
                    field: len(topic.get(field) or [])
                    for field in ("decisions", "experiences", "timeline")
                },
                "embedded": bool(topic.get("embedding_model_id")),
            }
            for topic in topics
        ],
    }


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main() -> int:
    from psycopg2.extensions import parse_dsn
    from redis import Redis
    from sentence_transformers import SentenceTransformer

    from .budget import budget_scope, build_budgeted_llm

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--budget-usd", type=float, default=1.0)
    parser.add_argument("--embedding-path", type=Path, required=True)
    parser.add_argument("--profile", type=Path, default=Path.home() / ".deepseek.env")
    parser.add_argument("--formation-count", type=int, default=RuntimeSettings.formation_count)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if args.out.exists():
        parser.error("--out already exists")

    dsn = os.environ["FRONTIER_PG_DSN"]
    redis_url = os.environ["FRONTIER_REDIS_URL"]
    db_host = parse_dsn(dsn).get("host", "")
    if not (_is_loopback(db_host) and _is_loopback(urlsplit(redis_url).hostname or "")):
        parser.error("The Add replay requires local PostgreSQL and Redis")

    manifest = json.loads(args.manifest.read_text())
    turns = manifest["turns"]
    try:
        work_count = validate_work_limit(turns)
    except ValueError as exc:
        parser.error(str(exc))
    requests = [request_for_turn(turn) for turn in turns]
    waves = [turn["wave"] for turn in turns]
    if not turns or waves != sorted(waves) or len({r.task_id for r in requests}) != len(turns):
        parser.error("Expected a nonempty ordered manifest with unique Turn IDs")

    started = time.monotonic()
    model = SentenceTransformer(
        str(args.embedding_path.resolve()), device="cpu", local_files_only=True
    )

    def embed(texts: list[str]) -> list[list[float]]:
        return model.encode(texts, normalize_embeddings=True, show_progress_bar=False).tolist()

    dimension = model.get_sentence_embedding_dimension()
    if dimension != 384 or len(embed(["embedding preflight"])[0]) != dimension:
        raise RuntimeError("Expected local 384-dimensional MiniLM")
    redis = Redis.from_url(redis_url)
    redis.ping()
    schema = f"frontier_eval_{uuid4().hex[:12]}"
    store = PostgresAddStore(
        {"dsn": dsn, "schema_name": schema, "embedding_dimension": dimension},
        project_id=schema,
    )

    complete = False
    ledger = None
    error = None
    try:
        with store.transaction() as cursor:
            cursor.execute(
                "INSERT INTO spaces (id, space_name, project_id) VALUES (%s, %s, %s)",
                (SPACE, "FrontierMemory pilot", store.project_id),
            )
            cursor.execute(
                "INSERT INTO domains (id, space_id, domain) VALUES (%s, %s, %s)",
                (DOMAIN, SPACE, DOMAIN),
            )
        llm = build_budgeted_llm(args.profile, args.ledger, cap_usd=args.budget_usd)
        ledger = llm.ledger

        class RecordedHub(ModelHub):
            def write(self, scope, prompt, inputs=None, placeholders=None):
                with budget_scope(scope):
                    return super().write(scope, prompt, inputs, placeholders)

            def judge(self, scope, state, questions):
                with budget_scope(scope):
                    return super().judge(scope, state, questions)

        logging.getLogger("memos.llms.openai").setLevel(logging.CRITICAL)
        if args.probe:
            try:
                with budget_scope("probe"):
                    reply = llm.generate(
                        [{"role": "user", "content": "Reply only OK."}], max_tokens=16
                    )
            except Exception as exc:
                raise RuntimeError(
                    f"Configured DeepSeek probe failed ({type(exc).__name__})"
                ) from None
            if reply.strip().rstrip(".") != "OK":
                raise RuntimeError("Configured DeepSeek probe returned unexpected text")
        ledger.ensure_open()
        clock = ReplayClock(datetime.now(timezone.utc))
        queue: deque[ScheduleMessageItem] = deque()
        settings = RuntimeSettings(formation_count=args.formation_count)
        runtime = EpisodeAddRuntime(
            store,
            RecordedHub(llm=llm, judge_backend="llm"),
            queue.extend,
            redis,
            settings,
            clock=clock,
            embedder=embed,
            embedding_model_id=EMBEDDING_MODEL,
        )
        for wave, group in groupby(zip(waves, requests, strict=False), key=lambda entry: entry[0]):
            for _, request in group:
                response = runtime.accept(request)
                if not response["success"] or response["_duplicate"]:
                    raise RuntimeError("Add did not accept a pilot Turn as a new request")
                clock.advance(1)
            clock.advance(runtime.acceptance.settings.idle_seconds + 1)
            # Close one due Episode at a time to preserve the manifest's arrival order.
            while runtime.acceptance.close_due(limit=1):
                drain_work(runtime, queue, clock, ledger)
            print(f"Wave {wave} completed", flush=True)
        complete = True
    except Exception as exc:
        error = type(exc).__name__
        raise
    finally:
        try:
            state = export_state(store, turns)
            _write_json(
                args.out,
                {
                    **state,
                    "complete": complete,
                    "error_type": error,
                    "schema": schema,
                    "memos_commit": subprocess.check_output(
                        ["git", "rev-parse", "HEAD"], text=True
                    ).strip(),
                    "formation_count": args.formation_count,
                    "gold_work_count": work_count,
                    "embedding_model": EMBEDDING_MODEL,
                    "seconds": round(time.monotonic() - started, 3),
                    "budget": ledger.summary() if ledger is not None else None,
                },
            )
        finally:
            store.close()
            redis.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
