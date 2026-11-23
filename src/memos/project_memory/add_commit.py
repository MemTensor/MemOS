"""PostgreSQL transaction for one prepared Episode result and its read projection."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from memos.exceptions import MemOSError

from .add_evidence import text_at
from .add_layout import SPACE_STATE, write_entries
from .add_merge import VersionConflictError
from .add_publish import publish_topics, sync_space
from .add_store import json_value, record_event
from .types import time_key


if TYPE_CHECKING:
    from .add_store import PostgresAddStore


class EpisodeFenceError(MemOSError):
    """The owning Space was cleared, removed, or no longer authorizes this work."""


class DraftWitnessError(MemOSError):
    """A draft does not have the durable source witness claimed in its extraction."""


def _query_episode(cursor: Any, project: str, episode_id: str, space: str) -> dict | None:
    cursor.execute(
        "SELECT * FROM episodes WHERE project_id = %s AND space_id = %s AND id = %s FOR UPDATE",
        (project, space, episode_id),
    )
    return cursor.fetchone()


def _quote_matches(row: dict, ref: dict, quote: str) -> bool:
    text = text_at(row, ref["source_path"])
    return (
        text is not None
        and 0 <= ref["start"] < ref["end"] <= len(text)
        and text[ref["start"] : ref["end"]] == quote
    )


def _assistant_precedes(proposal: dict, authorization: dict) -> bool:
    # Message Turn positions continue across Episodes in the same conversation.
    return (
        proposal["role"] == "assistant"
        and (proposal["turn_seq"], proposal["msg_seq"])
        < (authorization["turn_seq"], authorization["msg_seq"])
        and proposal["chat_time"] <= authorization["chat_time"]
        and proposal["accepted_at"] <= authorization["accepted_at"]
        and proposal["witness_accepted_at"] <= authorization["witness_accepted_at"]
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


def _assert_witnesses(cursor: Any, episode: dict) -> None:
    allowed_episodes = [episode["id"]]
    previous = episode.get("previous_episode_id")
    if previous and any(d.get("origin") == "adopted" for d in episode["drafts"]):
        allowed_episodes.append(previous)
    cursor.execute(
        """SELECT m.*, et.task_id AS origin_task_id, et.user_id AS origin_user_id,
                  et.episode_id AS witness_episode_id, et.accepted_at AS witness_accepted_at
           FROM episode_turns et JOIN messages m USING (project_id, conversation_key, turn_id)
           WHERE et.project_id = %s AND et.space_id = %s AND et.conversation_key = %s
             AND et.episode_id = ANY(%s::text[])""",
        (episode["project_id"], episode["space_id"], episode["conversation_key"], allowed_episodes),
    )
    rows = {row["message_id"]: row for row in cursor.fetchall()}
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


def refresh_topic_items(
    cursor: Any, topic: dict, *, item_embeddings: dict[str, str] | None = None
) -> None:
    """Write the Topic's entries as project_entries rows in the same transaction as the Topic."""
    write_entries(cursor, topic, embeddings=item_embeddings)


def _domain(cursor: Any, space: str, name: str | None) -> str | None:
    if not name:
        return None
    cursor.execute("SELECT id FROM domains WHERE space_id = %s AND domain = %s", (space, name))
    found = cursor.fetchone()
    return found["id"] if found else None


def _topic_edit(cursor: Any, edit: dict, key: str, current: dict, scoped: dict[str, dict]) -> None:
    topic = edit["topic"]
    space = current["space_id"]
    domain = topic.get("domain")
    if topic["space_id"] != space or not edit["episode_ids"]:
        raise EpisodeFenceError("ChangeSet Topic is outside the Episode Space")
    if not domain or any(domain not in scoped[eid]["domains"] for eid in edit["episode_ids"]):
        raise EpisodeFenceError("ChangeSet Topic is outside an Episode's domain scope")
    domain_id = _domain(cursor, space, domain)
    if domain_id is None or topic.get("domain_id", domain_id) != domain_id:
        raise VersionConflictError("Prepared Topic Domain is no longer available")

    vector = edit.get("embedding")
    model_id = edit.get("embedding_model_id") if vector is not None else None
    lists = (
        topic["topic_summary"],
        topic["topic_description"],
        json_value(topic.get("sources") or []),
        json_value(topic.get("anchors") or []),
        topic.get("anchor_keys") or [],
        topic["update_time"],
    )
    # Add's own Topic fields; the shared schema keeps them in topics.extra.
    marks = {"last_commit_key": key, "embedding_model_id": model_id}
    expected = edit["expected_version"]
    if expected is None:
        marks["created_by_episode_id"] = current["id"]
        cursor.execute(
            """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary, topic_description,
                                   sources, anchors, anchor_keys, update_time, create_time, extra, embedding)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                       %s::jsonb || jsonb_build_object('committed_at', clock_timestamp()), %s::vector)
               ON CONFLICT (id) DO NOTHING RETURNING version""",
            (
                topic["id"],
                space,
                domain_id,
                topic["topic_name"],
                *lists,
                topic["create_time"],
                json_value(marks),
                vector,
            ),
        )
    else:
        cursor.execute(
            """UPDATE topics SET topic_summary = %s, topic_description = %s, sources = %s,
                     anchors = %s, anchor_keys = %s, update_time = %s,
                     extra = extra || %s::jsonb || jsonb_build_object('committed_at', clock_timestamp()),
                     embedding = %s::vector, version = version + 1
               WHERE id = %s AND space_id = %s AND domain_id = %s AND version = %s RETURNING version""",
            (*lists, json_value(marks), vector, topic["id"], space, domain_id, expected),
        )
    written = cursor.fetchone()
    if written is None:
        raise VersionConflictError("A target Topic changed while preparing this Episode")
    refresh_topic_items(cursor, topic, item_embeddings=edit.get("item_embeddings"))


def _staged_episodes(cursor: Any, changes: dict, episode: dict) -> dict[str, dict]:
    scoped = {episode["id"]: episode}
    by_id = {item["episode_id"]: item for item in changes["staged_updates"]}
    for episode_id, update in sorted(by_id.items()):
        if episode_id == episode["id"]:
            continue
        row = _query_episode(cursor, episode["project_id"], episode_id, episode["space_id"])
        if row is None or row["staged_status"] != "active":
            raise VersionConflictError("A staged Episode is no longer eligible for Formation")
        if row["updated_at"].isoformat() != update.get("expected_updated_at"):
            raise VersionConflictError("A staged Episode changed while preparing Formation")
        scoped[episode_id] = row
    return scoped


def _finish_staged(cursor: Any, changes: dict, episode: dict) -> dict:
    stage = changes["staging"]
    current_update = {}
    for update in changes["staged_updates"]:
        if update["episode_id"] == episode["id"]:
            current_update = update
            continue
        cursor.execute(
            """UPDATE episodes SET staged_status = %s, moved_to_topic_id = %s,
                                   staged_attempts = %s, updated_at = now()
               WHERE id = %s AND project_id = %s AND space_id = %s""",
            (
                update["status"],
                update.get("topic_id"),
                update["attempts"],
                update["episode_id"],
                episode["project_id"],
                episode["space_id"],
            ),
        )
    if not stage:
        return {}
    stage_domain = _domain(cursor, episode["space_id"], stage.get("domain"))
    if stage.get("domain") and stage_domain is None:
        raise VersionConflictError("Prepared staged Domain is no longer available")
    return {
        "status": current_update.get("status", "active"),
        "domain": stage_domain,
        "reason": stage["reason"],
        "moved_to": current_update.get("topic_id"),
        "attempts": current_update.get("attempts", 0),
    }


def _finalize_episode(cursor: Any, changes: dict, episode: dict, key: str, staged: dict) -> dict:
    linked = changes["linked_topic_ids"]
    receipt = {
        "episode_id": episode["id"],
        "commit_key": key,
        "outcome": "committed" if linked else "staged",
        "topic_ids": linked,
        "created_topic_ids": changes["created_topic_ids"],
        "warnings": changes["warnings"],
    }
    cursor.execute(
        """UPDATE episodes SET commit_key = %s, outcome = %s, stage = 'done', result = %s,
                   created_topic_ids = %s, warnings = %s, staged_status = %s, staged_domain_id = %s,
                   staged_reason = %s, staged_at = CASE WHEN %s::text IS NULL THEN NULL ELSE now() END,
                   moved_to_topic_id = %s, staged_attempts = %s,
                   staged_tsv = CASE WHEN %s::text IS NULL THEN NULL
                                     ELSE to_tsvector('simple', coalesce(episode_summary,'')) END,
                   next_retry_at = NULL, updated_at = now()
           WHERE id = %s AND project_id = %s AND space_id = %s""",
        (
            key,
            receipt["outcome"],
            json_value(receipt),
            receipt["created_topic_ids"],
            json_value(receipt["warnings"]),
            staged.get("status"),
            staged.get("domain"),
            staged.get("reason"),
            staged.get("status"),
            staged.get("moved_to"),
            staged.get("attempts", 0),
            staged.get("status"),
            episode["id"],
            episode["project_id"],
            episode["space_id"],
        ),
    )
    record_event(
        cursor,
        episode["project_id"],
        episode["id"],
        "finished",
        stage="done",
        attempt=episode["attempt"],
        detail={"outcome": receipt["outcome"]},
    )
    return receipt


def commit_changeset(
    store: PostgresAddStore,
    episode_id: str,
    attempt: int,
    changeset: dict,
    *,
    work_token: str | None = None,
) -> dict:
    """Write the prepared result once under the caller's Space gate."""
    project = store.project_id
    space = changeset["space_id"]
    if changeset["episode_id"] != episode_id:
        raise EpisodeFenceError("ChangeSet belongs to a different Episode")
    key = f"{episode_id}:{attempt}"
    with store.transaction() as cursor:
        # Lock in the same order as Space clear and domain maintenance.
        cursor.execute(
            f"""SELECT s.*, {SPACE_STATE}, clock_timestamp() AS commit_clock
                  FROM spaces s LEFT JOIN add_space_state st ON st.space_id = s.id
                 WHERE s.project_id = %s AND s.id = %s FOR UPDATE OF s""",
            (project, space),
        )
        scope = cursor.fetchone()
        if scope is None:
            raise EpisodeFenceError("Space no longer exists in this project")
        current = _query_episode(cursor, project, episode_id, space)
        if current is None:
            raise EpisodeFenceError("Episode no longer exists in this Space")
        if current["commit_key"] == key:
            return current["result"]
        if (
            current["stage"] != "committing"
            or current["attempt"] != attempt
            or current["outcome"] != "pending"
        ):
            raise VersionConflictError("ChangeSet is from an inactive processing attempt")
        work = (current.get("organize_result") or {}).get("work") or {}
        expired = work.get("until") and time_key(work["until"]) <= time_key(scope["commit_clock"])
        if work_token is not None and (work_token != work.get("token") or expired):
            raise VersionConflictError("ChangeSet worker no longer owns its processing lease")
        if scope["cleared_at"] is not None and scope["cleared_at"] >= current["opened_at"]:
            raise EpisodeFenceError("Space was cleared after this Episode was accepted")
        formation = changeset["formation"]
        if formation and scope["formation_version"] != formation["version"]:
            raise VersionConflictError("Default Topic Formation changed during preparation")

        scoped = _staged_episodes(cursor, changeset, current)
        for row in scoped.values():
            if scope["cleared_at"] is not None and scope["cleared_at"] >= row["opened_at"]:
                raise EpisodeFenceError("A staged Episode predates the current Space contents")
            _assert_witnesses(cursor, row)
        for edit in sorted(changeset["topics"], key=lambda value: value["topic"]["id"]):
            _topic_edit(cursor, edit, key, current, scoped)
        if store.retrieval_index:
            sync_space(cursor, project, space)
            publish_topics(
                cursor,
                project,
                space,
                [edit["topic"]["id"] for edit in changeset["topics"]],
                scope["commit_clock"],
            )
        staged = _finish_staged(cursor, changeset, current)
        if formation:
            cursor.execute(
                """INSERT INTO add_space_state AS st (space_id, formation_version, last_formation_at)
                   VALUES (%s, 1, now())
                   ON CONFLICT (space_id) DO UPDATE SET formation_version = st.formation_version + 1,
                       last_formation_at = now(),
                       staged_since_last_formation = greatest(0, st.staged_since_last_formation - %s)""",
                (space, formation["consumed"]),
            )
        elif staged:
            cursor.execute(
                """INSERT INTO add_space_state AS st (space_id, staged_since_last_formation)
                   VALUES (%s, 1)
                   ON CONFLICT (space_id) DO UPDATE
                   SET staged_since_last_formation = st.staged_since_last_formation + 1""",
                (space,),
            )
        return _finalize_episode(cursor, changeset, current, key, staged)
