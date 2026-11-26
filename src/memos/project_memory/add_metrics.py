"""Per-Add timing and model usage derived from the Episode event log.

An Add request (Task) contributes Turns to one Episode per Space, and an Episode may also hold
Turns of other Tasks. Timing is reported per Episode and for the Task as a whole: the Task is
complete once every Episode holding its Turns has finished. Model usage is measured per Episode
stage and its tokens are split among the Tasks of the Episode in proportion to the input characters
of their Turns, with largest-remainder rounding so the Task shares add up exactly to the Episode's
total. Call counts are not split: each Task reports the calls of the Episodes it shares.

Event times come from the API worker clock, except an Episode finished by a commit, which uses the
database clock; components are clamped at zero so a small skew between them cannot go negative.
Episodes finished before event recording fall back to the row's update time (`finished_estimated`).
"""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING, Any

from memos.llms.usage import COUNTERS, merge_usage


if TYPE_CHECKING:
    from datetime import datetime


ATTRIBUTION = "turn_characters"
FALLBACK_ATTRIBUTION = "turn_count"


def _ms(start: datetime | None, end: datetime | None) -> int | None:
    if start is None or end is None:
        return None
    return max(0, round((end - start).total_seconds() * 1000))


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def episode_timeline(episode: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    """Phases of one Episode: buffering, then queueing, running and retry waits per stage.

    A stage end is matched to its claim by lease token: the next stage can be claimed before the
    previous worker records its end, so event order alone does not pair them.
    """
    opened = episode.get("opened_at")
    closed = episode.get("closed_at")
    finished = None
    finished_estimated = False
    outcome = episode.get("outcome")
    queue_ms = run_ms = retry_wait_ms = 0
    publishes = claims = retries = 0
    published_at = waiting_since = None
    stages: list[dict[str, Any]] = []
    claimed: dict[str, dict[str, Any]] = {}
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
            stage = {
                "label": detail.get("label"),
                "stage": event.get("stage"),
                "attempt": event.get("attempt"),
                "claimed_at": _iso(at),
                "queue_ms": waited,
                "run_ms": None,
            }
            stages.append(stage)
            if detail.get("token"):
                claimed[detail["token"]] = stage
        elif kind == "stage_done":
            rows = detail.get("usage") or []
            usage.append(rows)
            run = int(detail.get("run_ms") or 0)
            run_ms += run
            stage = claimed.pop(detail.get("token"), None)
            if stage is None:  # No recorded claim (e.g. claimed before event recording).
                stage = {"label": detail.get("label"), "stage": event.get("stage")}
                stages.append(stage)
            stage.update(
                run_ms=run,
                next_stage=detail.get("next_stage"),
                outcome=detail.get("outcome"),
                applied=detail.get("applied"),
                error=detail.get("error"),
                reason=detail.get("reason"),
                total_tokens=sum(int(row.get("total_tokens") or 0) for row in rows),
            )
            # A worker whose lease was taken over did not move the Episode into a retry.
            if detail.get("next_stage") == "retry_wait" and detail.get("applied"):
                retries += 1
                waiting_since = at
        elif kind == "finished":
            finished = at
            outcome = detail.get("outcome") or outcome
    if finished is None and episode.get("outcome") not in (None, "pending"):
        # Finished without a recorded event (before event recording existed). The row's
        # updated_at may move later (Formation archives staged Episodes), so flag it.
        finished = episode.get("updated_at")
        finished_estimated = finished is not None
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
        "finished_estimated": finished_estimated,
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


CALL_COUNTERS = ("calls", "failed_calls", "calls_without_usage")
TOKEN_COUNTERS = tuple(name for name in COUNTERS if name not in CALL_COUNTERS)


def attribute(rows: list[dict[str, Any]], weights: dict[str, int]) -> dict[str, list[dict]]:
    """Each Task's share of an Episode's usage rows.

    Token counters are split by weight and sum exactly to the Episode's. A call cannot be split,
    so every Task sharing the Episode reports the Episode's call counters in full.
    """
    out: dict[str, list[dict]] = {task: [] for task in weights}
    for row in rows:
        split = {name: allocate(int(row.get(name) or 0), weights) for name in TOKEN_COUNTERS}
        for task in weights:
            out[task].append(
                {
                    "kind": row["kind"],
                    "model": row["model"],
                    **{name: int(row.get(name) or 0) for name in CALL_COUNTERS},
                    **{name: split[name][task] for name in TOKEN_COUNTERS},
                }
            )
    return out


def turn_weights(
    members: list[dict[str, Any]], sizes: dict[tuple[str, str], int]
) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, int]], dict[str, str]]:
    """Per Episode, each Task's weight and Turn count, and the attribution method used.

    Weights are the Turns' input characters recorded at acceptance (at least 1 per Turn). An
    Episode with any Turn accepted before size recording splits equally per Turn instead.
    """
    weights: dict[str, dict[str, int]] = defaultdict(dict)
    turns: dict[str, dict[str, int]] = defaultdict(dict)
    by_episode: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in members:
        by_episode[row["episode_id"]].append(row)
    methods = {}
    for episode_id, rows in by_episode.items():
        sized = all((episode_id, row["turn_id"]) in sizes for row in rows)
        methods[episode_id] = ATTRIBUTION if sized else FALLBACK_ATTRIBUTION
        for row in rows:
            weight = max(1, sizes.get((episode_id, row["turn_id"]), 0)) if sized else 1
            task = row["task_id"]
            weights[episode_id][task] = weights[episode_id].get(task, 0) + weight
            turns[episode_id][task] = turns[episode_id].get(task, 0) + 1
    return weights, turns, methods


def _usage_summary(rows: list[dict[str, Any]], complete: bool, methods: set[str]) -> dict[str, Any]:
    return {
        "attribution": ATTRIBUTION if methods <= {ATTRIBUTION} else FALLBACK_ATTRIBUTION,
        "complete": complete,
        "total_tokens": sum(row["total_tokens"] for row in rows),
        "models": rows,
    }


def task_metrics(cursor: Any, project_id: str, task_id: str, user_id: str) -> dict[str, Any]:
    """Timing and attributed usage of one Add request, read in the caller's transaction.

    The Task's Episodes are the add_jobs rows listing it; each Turn's Task and size come from
    its `turn` event. Episodes without Turn events split equally among their Tasks."""
    cursor.execute(
        """SELECT j.episode_id AS id, j.space_id, j.stage, j.outcome, j.task_ids,
                  j.update_time AS updated_at, e.create_time AS opened_at,
                  j.organize_result->'close'->>'reason' AS close_reason,
                  (j.organize_result->'close'->>'at')::timestamptz AS closed_at,
                  (j.organize_result->'task_owners'->%s->>'accepted_at')::timestamptz
                      AS accepted_at,
                  j.organize_result ? 'extraction' AS extracted
           FROM add_jobs j JOIN episodes e ON e.id = j.episode_id
           WHERE j.project_id = %s AND j.task_ids @> ARRAY[%s]::text[]
             AND j.organize_result->'task_owners'->%s->>'user_id' = %s
           ORDER BY e.create_time, j.episode_id""",
        (task_id, project_id, task_id, task_id, user_id),
    )
    episodes = cursor.fetchall()
    for episode in episodes:
        stage = episode["stage"]
        episode["state"] = (
            "open" if stage == "episode_open" else "extracted" if episode["extracted"] else "closed"
        )
    episode_ids = [episode["id"] for episode in episodes]
    cursor.execute(
        """SELECT episode_id, event, at, stage, attempt, detail FROM add_episode_events
           WHERE project_id = %s AND episode_id = ANY(%s::text[]) ORDER BY episode_id, at, id""",
        (project_id, episode_ids),
    )
    events: dict[str, list[dict]] = defaultdict(list)
    sizes: dict[tuple[str, str], int] = {}
    members: list[dict[str, Any]] = []
    for row in cursor.fetchall():
        events[row["episode_id"]].append(row)
        if row["event"] == "turn":
            detail = row["detail"]
            sizes[(row["episode_id"], detail.get("turn_id"))] = int(detail.get("chars") or 0)
            members.append(
                {
                    "episode_id": row["episode_id"],
                    "task_id": detail.get("task_id"),
                    "turn_id": detail.get("turn_id"),
                }
            )
    counted = {member["episode_id"] for member in members}
    for episode in episodes:
        if episode["id"] not in counted:
            members.extend(
                {"episode_id": episode["id"], "task_id": task, "turn_id": f"task:{task}"}
                for task in episode["task_ids"]
            )
    weights, turns, methods = turn_weights(members, sizes)
    own = episodes

    accepted = min((row["accepted_at"] for row in own), default=None)
    timelines = []
    task_usage = []
    complete = True
    for episode in episodes:
        timeline = episode_timeline(episode, events[episode["id"]])
        episode_weights = weights[episode["id"]]
        share = episode_weights.get(task_id, 0) / max(1, sum(episode_weights.values()))
        timeline.update(
            attribution=methods.get(episode["id"], ATTRIBUTION),
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
        "usage": _usage_summary(
            merge_usage(*task_usage),
            complete and all_finished,
            {timeline["attribution"] for timeline in timelines},
        ),
        "episodes": timelines,
    }
