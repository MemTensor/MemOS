"""Per-Add timing and model usage derived from the Episode event log.

An Add request (Task) contributes Turns to one Episode per Space, and an Episode may also hold
Turns of other Tasks. Timing is reported per Episode and for the Task as a whole: the Task is
complete once every Episode holding its Turns has finished. Model usage is measured per Episode
stage and split among the Tasks of the Episode in proportion to the input characters of their
Turns, with largest-remainder rounding so the Task shares of every counter add up exactly to the
Episode's total.

Event times come from the database clock (acceptance and commit) and the worker clock (dispatch
and stages); components are clamped at zero so a small skew between them cannot go negative.
"""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING, Any

from memos.llms.usage import COUNTERS, merge_usage


if TYPE_CHECKING:
    from datetime import datetime


ATTRIBUTION = "turn_characters"


def _ms(start: datetime | None, end: datetime | None) -> int | None:
    if start is None or end is None:
        return None
    return max(0, round((end - start).total_seconds() * 1000))


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def episode_timeline(episode: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    """Phases of one Episode: buffering, then queueing, running and retry waits per stage."""
    opened = episode.get("opened_at")
    closed = episode.get("closed_at")
    finished = None
    outcome = episode.get("outcome")
    queue_ms = run_ms = retry_wait_ms = 0
    publishes = claims = retries = 0
    published_at = waiting_since = None
    stages: list[dict[str, Any]] = []
    open_stage: dict[str, Any] | None = None
    usage: list[list[dict[str, Any]]] = []
    for event in events:
        kind, at, detail = event["event"], event["at"], event.get("detail") or {}
        if kind == "opened":
            opened = at
        elif kind == "closed":
            closed = at
        elif kind == "published":
            publishes += 1
            if waiting_since is not None:
                retry_wait_ms += _ms(waiting_since, at) or 0
                waiting_since = None
            if published_at is None:
                published_at = at
        elif kind == "claimed":
            claims += 1
            waited = _ms(published_at, at) or 0
            queue_ms += waited
            published_at = None
            open_stage = {
                "label": detail.get("label"),
                "stage": event.get("stage"),
                "attempt": event.get("attempt"),
                "claimed_at": _iso(at),
                "queue_ms": waited,
                "run_ms": None,
            }
            stages.append(open_stage)
        elif kind == "stage_done":
            rows = detail.get("usage") or []
            usage.append(rows)
            run = int(detail.get("run_ms") or 0)
            run_ms += run
            if open_stage is None:  # A claim from before event recording; keep the run.
                open_stage = {"label": detail.get("label"), "stage": event.get("stage")}
                stages.append(open_stage)
            open_stage.update(
                run_ms=run,
                next_stage=detail.get("next_stage"),
                outcome=detail.get("outcome"),
                error=detail.get("error"),
                reason=detail.get("reason"),
                total_tokens=sum(int(row.get("total_tokens") or 0) for row in rows),
            )
            open_stage = None
            if detail.get("next_stage") == "retry_wait":
                retries += 1
                waiting_since = at
        elif kind == "finished":
            finished = at
            outcome = detail.get("outcome") or outcome
    processing = _ms(closed, finished)
    return {
        "episode_id": episode["id"],
        "space_id": episode.get("space_id"),
        "state": episode.get("state"),
        "outcome": outcome,
        "close_reason": episode.get("close_reason"),
        "opened_at": _iso(opened),
        "closed_at": _iso(closed),
        "finished_at": _iso(finished),
        "buffer_ms": _ms(opened, closed),
        "processing_ms": processing,
        "queue_ms": queue_ms,
        "run_ms": run_ms,
        "retry_wait_ms": retry_wait_ms,
        "other_ms": max(0, processing - queue_ms - run_ms - retry_wait_ms)
        if processing is not None
        else None,
        "publishes": publishes,
        "claims": claims,
        "retries": retries,
        # A claim without a recorded stage end (worker lost mid-stage) leaves usage unknown.
        "unfinished_stages": sum(1 for stage in stages if stage.get("run_ms") is None),
        "stages": stages,
        "usage": merge_usage(*usage),
        "_finished": finished,
        "_closed": closed,
    }


def allocate(total: int, weights: dict[str, int]) -> dict[str, int]:
    """Split a non-negative integer by weight with largest remainders; ties go by key order."""
    keys = sorted(weights)
    weight_sum = sum(weights.values())
    if total <= 0 or weight_sum <= 0:
        return dict.fromkeys(keys, 0)
    exact = {key: total * weights[key] / weight_sum for key in keys}
    shares = {key: int(exact[key]) for key in keys}
    rest = total - sum(shares.values())
    for key in sorted(keys, key=lambda key: (-(exact[key] - shares[key]), key))[:rest]:
        shares[key] += 1
    return shares


def attribute(rows: list[dict[str, Any]], weights: dict[str, int]) -> dict[str, list[dict]]:
    """Each Task's share of an Episode's usage rows, counter by counter."""
    out: dict[str, list[dict]] = {task: [] for task in weights}
    for row in rows:
        split = {name: allocate(int(row.get(name) or 0), weights) for name in COUNTERS}
        for task in weights:
            out[task].append(
                {
                    "kind": row["kind"],
                    "model": row["model"],
                    **{name: split[name][task] for name in COUNTERS},
                }
            )
    return out


def _usage_summary(rows: list[dict[str, Any]], complete: bool) -> dict[str, Any]:
    return {
        "attribution": ATTRIBUTION,
        "complete": complete,
        "total_tokens": sum(row["total_tokens"] for row in rows),
        "models": rows,
    }


def task_metrics(cursor: Any, project_id: str, task_id: str, user_id: str) -> dict[str, Any]:
    """Timing and attributed usage of one Add request, read in the caller's transaction."""
    cursor.execute(
        """SELECT episode_id, turn_id, accepted_at FROM episode_turns
           WHERE project_id = %s AND task_id = %s AND user_id = %s""",
        (project_id, task_id, user_id),
    )
    own = cursor.fetchall()
    episode_ids = sorted({row["episode_id"] for row in own})
    cursor.execute(
        """SELECT id, space_id, state, stage, outcome, close_reason, opened_at, closed_at
           FROM episodes WHERE project_id = %s AND id = ANY(%s::text[]) ORDER BY opened_at, id""",
        (project_id, episode_ids),
    )
    episodes = cursor.fetchall()
    cursor.execute(
        """SELECT et.episode_id, et.task_id,
                  SUM(GREATEST(1, COALESCE(m.size, 0))) AS weight, COUNT(*) AS turns
           FROM episode_turns et
           LEFT JOIN LATERAL (
               SELECT SUM(char_length(content) + CASE
                          WHEN tool_calls IS NULL OR tool_calls IN ('null', '[]') THEN 0
                          ELSE char_length(tool_calls::text) END) AS size
               FROM messages m
               WHERE m.project_id = et.project_id AND m.conversation_key = et.conversation_key
                 AND m.turn_id = et.turn_id AND m.role <> 'system'
           ) m ON TRUE
           WHERE et.project_id = %s AND et.episode_id = ANY(%s::text[])
           GROUP BY et.episode_id, et.task_id""",
        (project_id, episode_ids),
    )
    weights: dict[str, dict[str, int]] = defaultdict(dict)
    turns: dict[str, dict[str, int]] = defaultdict(dict)
    for row in cursor.fetchall():
        weights[row["episode_id"]][row["task_id"]] = int(row["weight"])
        turns[row["episode_id"]][row["task_id"]] = int(row["turns"])
    cursor.execute(
        """SELECT episode_id, event, at, stage, attempt, detail FROM add_episode_events
           WHERE project_id = %s AND episode_id = ANY(%s::text[]) ORDER BY episode_id, at, id""",
        (project_id, episode_ids),
    )
    events: dict[str, list[dict]] = defaultdict(list)
    for row in cursor.fetchall():
        events[row["episode_id"]].append(row)

    accepted = min((row["accepted_at"] for row in own), default=None)
    timelines = []
    task_usage = []
    complete = True
    for episode in episodes:
        timeline = episode_timeline(episode, events[episode["id"]])
        episode_weights = weights[episode["id"]]
        share = episode_weights.get(task_id, 0) / max(1, sum(episode_weights.values()))
        timeline.update(
            turns=sum(turns[episode["id"]].values()),
            task_turns=turns[episode["id"]].get(task_id, 0),
            tasks=len(episode_weights),
            share=round(share, 6),
        )
        task_usage.append(attribute(timeline["usage"], episode_weights).get(task_id, []))
        complete = complete and bool(
            timeline["_finished"]
            and not timeline["unfinished_stages"]
            and not any(
                row["calls_without_usage"] or row["failed_calls"] for row in timeline["usage"]
            )
        )
        timelines.append(timeline)

    finished = [timeline.pop("_finished") for timeline in timelines]
    closed = [timeline.pop("_closed") for timeline in timelines]
    all_closed = bool(closed) and all(closed)
    all_finished = bool(finished) and all(finished)
    closed_at = max(closed) if all_closed else None
    completed_at = max(finished) if all_finished else None
    return {
        "accepted_at": _iso(accepted),
        "closed_at": _iso(closed_at),
        "completed_at": _iso(completed_at),
        "close_wait_ms": _ms(accepted, closed_at),
        "processing_ms": _ms(closed_at, completed_at),
        "latency_ms": _ms(accepted, completed_at),
        "usage": _usage_summary(merge_usage(*task_usage), complete and all_finished),
        "episodes": timelines,
    }
