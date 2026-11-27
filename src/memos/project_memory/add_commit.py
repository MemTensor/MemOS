"""PostgreSQL transaction for one prepared Episode result and its read projection.

A prepared changeset (add_merge.prepare_merge) carries proposed Topic snapshots. The commit
diffs each against the committed Topic (add_layout.topic_create / topic_update) and writes them
with `write_change_set` in the same transaction as the Episode's receipt, its staged state and
the Formation columns of the Space. Storage generates the ids of new Topics and entries; the
results come back creates first, so the placeholder ids of the changeset are mapped to the real
ones before the receipt (add_jobs.topic_ids), episodes.topic_id and staged moves are written.

Retry safety: the Topic writes are fenced by each Topic's version (expected_version, or the
committed version that must equal it), Formation by spaces.formation_version and each staged
Episode's update_time, and the Episode by its stage, attempt and lease token. A replay of an
applied attempt finds `receipt.commit_key` and returns the stored receipt.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from memos.exceptions import MemOSError
from memos.project_dbs.exceptions import (
    DomainNotFoundError,
    EntryNotFoundError,
    SpaceClearedError,
    SpaceNotFoundError,
    TopicNotFoundError,
)
from memos.project_dbs.exceptions import VersionConflictError as StorageVersionConflict
from memos.project_dbs.item import TopicChangeSet
from memos.project_dbs.postgres_writer import write_change_set

from .add_evidence import text_at
from .add_layout import aware_time, current_schema, load_topics, mark_topics
from .add_layout import topic_create as build_create
from .add_layout import topic_update as build_update
from .add_merge import VersionConflictError
from .add_store import KEEP_PERSISTENT, PERSISTENT_KEYS, json_value, load_episode, read_space
from .add_store import record_event as add_event
from .types import time_key


if TYPE_CHECKING:
    from .add_store import PostgresAddStore


class EpisodeFenceError(MemOSError):
    """The owning Space was cleared, removed, or no longer authorizes this work."""


class DraftWitnessError(MemOSError):
    """A draft does not have the durable source witness claimed in its extraction."""


def _quote_matches(row: dict, ref: dict, quote: str) -> bool:
    text = text_at(row, ref["source_path"])
    return (
        text is not None
        and 0 <= ref["start"] < ref["end"] <= len(text)
        and text[ref["start"] : ref["end"]] == quote
    )


def _assistant_precedes(proposal: dict, authorization: dict) -> bool:
    # msg_seq orders the whole conversation, across Episodes.
    return (
        proposal["role"] == "assistant"
        and proposal["msg_seq"] < authorization["msg_seq"]
        and proposal["chat_time"] <= authorization["chat_time"]
        and proposal["accept_time"] <= authorization["accept_time"]
    )


def _has_adoption_witness(draft: dict, authorization: dict, rows: dict[str, dict]) -> bool:
    for evidence in draft.get("evidence") or []:
        ref = evidence.get("ref") or {}
        if (
            evidence.get("kind") == "assistant_proposal"
            and ref in (draft.get("context_refs") or [])
            and ref.get("source_path") == "/content"
            and (proposal := rows.get(ref.get("message_id"))) is not None
            and _assistant_precedes(proposal, authorization)
            and _quote_matches(proposal, ref, evidence.get("quote"))
        ):
            return True
    return False


def _witness_rows(cursor: Any, episode: dict) -> dict[str, dict]:
    """The Episode's messages (and its predecessor's for adopted drafts) with their owner."""
    episodes = [episode]
    previous = episode.get("previous_episode_id")
    adopted = any(d.get("origin") == "adopted" for d in episode["drafts"])
    if previous and adopted and (prior := load_episode(cursor, previous)):
        episodes.append(prior)
    rows = {}
    for item in episodes:
        for message in item["messages"]:
            rows[message["message_id"]] = {**message, "witness_episode_id": item["id"]}
    return rows


def _assert_witnesses(cursor: Any, episode: dict) -> None:
    rows = _witness_rows(cursor, episode)
    for draft in episode["drafts"]:
        owner = draft.get("origin_task_id")
        refs = draft.get("source_refs") or []
        if not owner or not refs or draft.get("episode_id") != episode["id"]:
            raise DraftWitnessError("Draft missing its Episode and source witnesses")
        for ref in refs:
            row = rows.get(ref["message_id"])
            if (
                row is None
                or row["origin_task_id"] != owner
                or row["witness_episode_id"] != episode["id"]
                or row["role"] == "system"
            ):
                raise DraftWitnessError("Draft source is not owned by its original Task")
            if not _quote_matches(row, ref, draft["quote"]):
                raise DraftWitnessError("Draft quote differs from the committed trajectory")
            if draft["kind"] == "decision":
                author = row.get("role_id") or row["origin_user_id"]
                if row["role"] != "user" or author not in draft["authors"]:
                    raise DraftWitnessError(
                        "Decision authorization must be a member's original statement"
                    )
            if draft.get("origin") == "adopted" and (
                row["role"] != "user"
                or ref not in (draft.get("authorizing_evidence_refs") or [])
                or not _has_adoption_witness(draft, row, rows)
            ):
                raise DraftWitnessError(
                    "Adoption requires an earlier assistant proposal in the same Space and conversation"
                )


def _domain_ids(cursor: Any, space: str) -> dict[str, str]:
    cursor.execute("SELECT domain, id FROM domains WHERE space_id = %s", (space,))
    return {row["domain"]: row["id"] for row in cursor.fetchall()}


def _check_scope(edit: dict, space: str, domains: dict[str, str], scoped: dict[str, dict]) -> None:
    topic = edit["topic"]
    domain = topic.get("domain")
    if topic["space_id"] != space or not edit["episode_ids"]:
        raise EpisodeFenceError("ChangeSet Topic is outside the Episode Space")
    if not domain or any(domain not in scoped[eid]["domains"] for eid in edit["episode_ids"]):
        raise EpisodeFenceError("ChangeSet Topic is outside an Episode's domain scope")
    domain_id = domains.get(domain)
    if domain_id is None or topic.get("domain_id", domain_id) != domain_id:
        raise VersionConflictError("Prepared Topic Domain is no longer available")


def _write_topics(
    cursor: Any, changeset: dict, scoped: dict[str, dict], accept_time: Any, key: str
) -> tuple[dict[str, str], list[str]]:
    """Write the changeset's Topics; returns placeholder -> stored id and the created ids."""
    space = changeset["space_id"]
    domains = _domain_ids(cursor, space)
    edits = sorted(changeset["topics"], key=lambda value: value["topic"]["id"])
    for edit in edits:
        _check_scope(edit, space, domains, scoped)
    updates = [edit for edit in edits if edit["expected_version"] is not None]
    committed = {}
    if updates:
        rows = load_topics(
            cursor,
            "t.space_id = %s AND t.id = ANY(%s::text[])",
            (space, [edit["topic"]["id"] for edit in updates]),
        )
        committed = {row["id"]: row for row in rows}
    creates = [edit for edit in edits if edit["expected_version"] is None]
    change_set = TopicChangeSet(
        space_id=space,
        accept_time=aware_time(accept_time),
        creates=[
            build_create(
                edit["topic"],
                vectors=edit.get("item_embeddings"),
                embedding=edit.get("embedding"),
            )
            for edit in creates
        ],
        updates=[
            build_update(
                _base(committed, edit),
                edit["topic"],
                vectors=edit.get("item_embeddings"),
                embedding=edit.get("embedding"),
            )
            for edit in updates
        ],
    )
    try:
        results = write_change_set(cursor, change_set, schema=current_schema(cursor))
    except (SpaceClearedError, SpaceNotFoundError) as exc:
        raise EpisodeFenceError(str(exc)) from exc
    except (StorageVersionConflict, TopicNotFoundError, DomainNotFoundError) as exc:
        raise VersionConflictError(str(exc)) from exc
    except EntryNotFoundError as exc:
        raise VersionConflictError(str(exc)) from exc
    ids = {
        edit["topic"]["id"]: result.topic_id for edit, result in zip(creates, results, strict=False)
    }
    ids.update({edit["topic"]["id"]: edit["topic"]["id"] for edit in updates})
    for edit in edits:
        vector = edit.get("embedding")
        model = edit.get("embedding_model_id") if vector is not None else None
        marks = {"last_commit_key": key, "embedding_model_id": model}
        if edit["expected_version"] is None:
            marks["created_by_episode_id"] = edit["episode_ids"][0]
        mark_topics(cursor, [ids[edit["topic"]["id"]]], marks)
    return ids, [ids[edit["topic"]["id"]] for edit in creates]


def _base(committed: dict[str, dict], edit: dict) -> dict:
    """The committed Topic the edit was prepared from; another version is a conflict."""
    base = committed.get(edit["topic"]["id"])
    if base is None or base["version"] != edit["expected_version"]:
        raise VersionConflictError("A target Topic changed while preparing this Episode")
    return base


def _staged_episodes(cursor: Any, changes: dict, episode: dict | None = None) -> dict[str, dict]:
    """The Episodes a changeset may touch: the carrier and every staged Episode it moves or
    ages, each still staged and unchanged since Formation read it."""
    scoped = {episode["id"]: episode} if episode else {}
    by_id = {item["episode_id"]: item for item in changes["staged_updates"]}
    for episode_id, update in sorted(by_id.items()):
        if episode_id in scoped:
            continue
        row = load_episode(cursor, episode_id, lock=True)
        if row is None or row["space_id"] != changes["space_id"] or row["outcome"] != "staged":
            raise VersionConflictError("A staged Episode is no longer eligible for Formation")
        if time_key(row["update_time"]) != time_key(update.get("expected_updated_at")):
            raise VersionConflictError("A staged Episode changed while preparing Formation")
        scoped[episode_id] = row
    return scoped


def _set_staged(
    cursor: Any, episode_id: str, staged: dict, outcome: str, topic_id: str | None, now: Any
) -> None:
    cursor.execute(
        f"""UPDATE add_jobs SET outcome = %s, update_time = %s,
                  organize_result = {KEEP_PERSISTENT}
                      || jsonb_build_object('staged', %s::jsonb)
            WHERE episode_id = %s""",
        (outcome, now, list(PERSISTENT_KEYS), json_value(staged), episode_id),
    )
    if topic_id:
        cursor.execute("UPDATE episodes SET topic_id = %s WHERE id = %s", (topic_id, episode_id))


def _write_staged_updates(
    cursor: Any,
    changes: dict,
    scoped: dict[str, dict],
    ids: dict[str, str],
    now: Any,
    skip: str | None = None,
) -> None:
    """Moved Episodes leave the Default Topic for their Topic (outcome committed, the task
    receipt unchanged); archived and long-unassigned ones end skipped; the rest stay staged
    with their attempt count."""
    for update in changes["staged_updates"]:
        if update["episode_id"] == skip:
            continue
        episode = scoped[update["episode_id"]]
        target = ids.get(update.get("topic_id")) if update.get("topic_id") else None
        staged = {
            "status": update["status"],
            "domain": episode.get("staged_domain"),
            "reason": episode.get("staged_reason"),
            "at": (episode.get("staged_at") or now).isoformat(),
            "attempts": update["attempts"],
            "moved_to": target,
        }
        outcome = {"active": "staged", "moved": "committed"}.get(update["status"], "skipped")
        _set_staged(cursor, update["episode_id"], staged, outcome, target, now)


def _finalize_episode(
    cursor: Any, changes: dict, episode: dict, key: str, ids: dict[str, str], created: list, now
) -> dict:
    linked = [ids[topic] for topic in changes["linked_topic_ids"]]
    receipt = {
        "episode_id": episode["id"],
        "commit_key": key,
        "outcome": "committed" if linked else "staged",
        "topic_ids": linked,
        "created_topic_ids": [ids[t] for t in changes["created_topic_ids"] if t in ids] or created,
        "warnings": list(dict.fromkeys([*episode.get("warnings", []), *changes["warnings"]])),
    }
    persist = {"receipt": receipt}
    stage = changes["staging"]
    update = next((u for u in changes["staged_updates"] if u["episode_id"] == episode["id"]), {})
    if stage and not linked:
        persist["staged"] = {
            "status": update.get("status", "active"),
            "domain": stage.get("domain"),
            "reason": stage["reason"],
            "at": now.isoformat(),
            "attempts": update.get("attempts", 0),
            "moved_to": None,
        }
        if persist["staged"]["status"] in ("archived", "long_unassigned"):
            receipt["outcome"] = "skipped"
    cursor.execute(
        f"""UPDATE add_jobs SET stage = 'done', outcome = %s, topic_ids = %s,
                  next_retry_time = NULL, update_time = %s,
                  organize_result = {KEEP_PERSISTENT} || %s::jsonb
            WHERE episode_id = %s""",
        (
            receipt["outcome"],
            linked,
            now,
            list(PERSISTENT_KEYS),
            json_value(persist),
            episode["id"],
        ),
    )
    if linked:
        cursor.execute(
            "UPDATE episodes SET topic_id = %s WHERE id = %s", (linked[0], episode["id"])
        )
    add_event(
        cursor,
        episode["project_id"],
        episode["id"],
        "finished",
        stage="done",
        attempt=episode["attempt"],
        detail={"outcome": receipt["outcome"]},
    )
    return receipt


def _advance_formation(cursor: Any, space: str, now: Any) -> None:
    """A new Formation version; Episodes staged at or before `now` are no longer counted."""
    cursor.execute(
        """UPDATE spaces SET formation_version = formation_version + 1, last_formation_time = %s
           WHERE id = %s""",
        (now, space),
    )


def _fence(scope: dict | None, accepted: Any) -> None:
    if scope is None:
        raise EpisodeFenceError("Space no longer exists")
    if scope["clear_time"] is not None and scope["clear_time"] >= accepted:
        raise EpisodeFenceError("Space was cleared after this Episode was accepted")


def commit_changeset(
    store: PostgresAddStore,
    episode_id: str,
    attempt: int,
    changeset: dict,
    *,
    work_token: str | None = None,
) -> dict:
    """Write the prepared result once under the caller's Space gate."""
    space = changeset["space_id"]
    if changeset["episode_id"] != episode_id:
        raise EpisodeFenceError("ChangeSet belongs to a different Episode")
    key = f"{episode_id}:{attempt}"
    with store.transaction() as cursor:
        # Lock in the same order as Space clear and domain maintenance.
        scope = read_space(cursor, space, lock=True)
        if scope is None:
            raise EpisodeFenceError("Space no longer exists")
        current = load_episode(cursor, episode_id, lock=True)
        if current is None or current["space_id"] != space:
            raise EpisodeFenceError("Episode no longer exists in this Space")
        if current["commit_key"] == key:
            return current["result"]
        if (
            current["stage"] != "committing"
            or current["attempt"] != attempt
            or current["outcome"] != "pending"
        ):
            raise VersionConflictError("ChangeSet is from an inactive processing attempt")
        now = scope["commit_clock"]
        work = current["organize_result"].get("work") or {}
        expired = work.get("until") and time_key(work["until"]) <= time_key(now)
        if work_token is not None and (work_token != work.get("token") or expired):
            raise VersionConflictError("ChangeSet worker no longer owns its processing lease")
        _fence(scope, current["accept_time"])
        formation = changeset["formation"]
        if formation and scope["formation_version"] != formation["version"]:
            raise VersionConflictError("Default Topic Formation changed during preparation")

        scoped = _staged_episodes(cursor, changeset, current)
        for row in scoped.values():
            _fence(scope, row["accept_time"])
            _assert_witnesses(cursor, row)
        # Formation merges several Episodes: the change set is as old as the earliest.
        accepted = min((row["accept_time"] for row in scoped.values()), key=time_key)
        ids, created = _write_topics(cursor, changeset, scoped, accepted, key)
        _write_staged_updates(cursor, changeset, scoped, ids, now, skip=current["id"])
        if formation:
            _advance_formation(cursor, space, now)
        return _finalize_episode(cursor, changeset, current, key, ids, created, now)


def commit_formation(store: PostgresAddStore, changeset: dict) -> dict:
    """Write a Space-level Formation that no new Episode carries, under the Space gate."""
    space = changeset["space_id"]
    formation = changeset.get("formation")
    if changeset.get("episode_id") is not None or not formation:
        raise EpisodeFenceError("Space Formation needs a ChangeSet without a carrier Episode")
    with store.transaction() as cursor:
        scope = read_space(cursor, space, lock=True)
        if scope is None:
            raise EpisodeFenceError("Space no longer exists")
        if scope["formation_version"] != formation["version"]:
            raise VersionConflictError("Default Topic Formation changed during preparation")
        now = scope["commit_clock"]
        scoped = _staged_episodes(cursor, changeset)
        for row in scoped.values():
            _fence(scope, row["accept_time"])
            _assert_witnesses(cursor, row)
        key = f"formation:{space}:{formation['version']}"
        ids, created = {}, []
        if changeset["topics"]:
            accepted = min((row["accept_time"] for row in scoped.values()), key=time_key)
            ids, created = _write_topics(cursor, changeset, scoped, accepted, key)
        _write_staged_updates(cursor, changeset, scoped, ids, now)
        _advance_formation(cursor, space, now)
    return {
        "formation_version": formation["version"] + 1,
        "topic_ids": sorted(set(ids.values())),
        "created_topic_ids": sorted(created),
        "moved": {
            u["episode_id"]: ids.get(u["topic_id"])
            for u in changeset["staged_updates"]
            if u["topic_id"]
        },
    }
