"""Expose the existing project read and management operations over Add's authoritative tables."""

from __future__ import annotations

import contextlib

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from .add_entry_fields import (
    experience_conversation_id,
    experience_retired,
    experience_status,
    experience_user_id,
)
from .add_layout import load_topics
from .add_publish import publish_topics, retract_topics, sync_space
from .add_store import json_value, record_event
from .graph_store import cosine, lexical_sim
from .types import (
    PROJECT_DECISION,
    PROJECT_EXPERIENCE,
    Decision,
    Domain,
    ExperienceCard,
    Msg,
    Space,
    Topic,
)


if TYPE_CHECKING:
    from collections.abc import Callable

    from .add_legacy import LegacyArchive
    from .add_store import PostgresAddStore


@dataclass
class _StoredSpace(Space):
    domain_ids: dict[int, str] = field(default_factory=dict, repr=False)


def _topic(row: dict[str, Any]) -> Topic:
    return Topic.from_node(
        row["id"],
        {
            **row,
            "topic_sources": row["sources"],
            "create_time": row["create_time"].isoformat(),
            "update_time": row["update_time"].isoformat(),
        },
    )


def _decision(row: dict[str, Any], item: dict[str, Any]) -> Decision:
    return Decision.from_node(
        item["id"],
        item.get("content", ""),
        {"project": {**item, "space_id": row["space_id"], "topic_id": row["id"]}},
    )


def _experience(row: dict[str, Any], item: dict[str, Any]) -> ExperienceCard:
    card = item.get("card") or {}
    return ExperienceCard.from_node(
        item["id"],
        {
            "user_name": row["space_id"],
            "user_id": experience_user_id(item),
            "session_id": experience_conversation_id(item),
            "confidence": item.get("confidence", 0.5),
            "version": item.get("version", 1),
            "topic_ids": list(dict.fromkeys([*item.get("legacy_topic_ids", []), row["id"]])),
            "anchors": card.get("anchors", []),
            "info": {
                **card,
                "exp_status": experience_status(item),
                "quality_score": item.get("quality_score"),
                "signal": item.get("signal"),
                "author_ids": item.get("user_ids") or [],
                "time": item.get("time") or "",
                "last_supported_at": item.get("last_supported_at") or "",
                "use_count": item.get("use_count", 0),
            },
            "status": "archived" if experience_retired(item) else "activated",
            "sources": item.get("sources") or [],
            "history": item.get("history") or [],
        },
    )


class RelationalProjectView:
    def __init__(
        self,
        store: PostgresAddStore,
        embedder: Callable[[list[str]], list[list[float]]] | None = None,
        legacy: LegacyArchive | None = None,
    ) -> None:
        self.store = store
        self.embedder = embedder
        self.legacy = legacy

    def get_space(self, space_id: str) -> Space | None:
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT s.*, COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.domain,
                           'description', d.description) ORDER BY d.create_time, d.domain)
                       FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS configured_domains
                   FROM spaces s LEFT JOIN domains d ON d.space_id = s.id
                   WHERE s.id = %s GROUP BY s.id""",
                (space_id,),
            )
            row = cursor.fetchone()
        if row is None:
            return None
        domains = [
            Domain(domain["name"], domain["description"]) for domain in row["configured_domains"]
        ]
        return _StoredSpace(
            space_id=row["id"],
            project_id=row["project_id"],
            space_name=row["space_name"],
            instructions=row["instructions"] or "",
            domains=domains,
            create_time=row["create_time"].isoformat(),
            update_time=row["update_time"].isoformat(),
            domain_ids={
                id(domain): raw["id"]
                for domain, raw in zip(domains, row["configured_domains"], strict=True)
            },
        )

    def put_space(self, space: Space) -> None:
        with self.store.transaction() as cursor:
            cursor.execute("SELECT * FROM spaces WHERE id = %s FOR UPDATE", (space.space_id,))
            current = cursor.fetchone()
            if current is None:
                project_id = space.project_id
                if not project_id:
                    raise ValueError("project_id 不能为空")
                cursor.execute(
                    """INSERT INTO spaces (id, project_id, space_name, instructions, create_time, update_time)
                       VALUES (%s, %s, %s, %s, %s, clock_timestamp()) RETURNING update_time""",
                    (
                        space.space_id,
                        space.project_id,
                        space.space_name,
                        space.instructions,
                        space.create_time,
                    ),
                )
            else:
                project_id = current["project_id"]
                if (
                    isinstance(space, _StoredSpace)
                    and space.update_time != current["update_time"].isoformat()
                ):
                    raise ValueError(
                        "Space changed while updating it; retry with the current Space"
                    )
                cursor.execute(
                    """UPDATE spaces SET space_name = %s, instructions = %s, update_time = clock_timestamp()
                       WHERE id = %s RETURNING update_time""",
                    (space.space_name, space.instructions, space.space_id),
                )
            updated_at = cursor.fetchone()["update_time"]
            renamed = self._replace_domains(cursor, space)
            if self.store.retrieval_index:
                sync_space(cursor, project_id, space.space_id)
                if renamed:
                    # A Topic's domain name is part of its index snapshot.
                    cursor.execute(
                        """UPDATE topics SET version = version + 1
                           WHERE space_id = %s AND domain_id = ANY(%s) RETURNING id""",
                        (space.space_id, renamed),
                    )
                    publish_topics(
                        cursor,
                        project_id,
                        space.space_id,
                        [row["id"] for row in cursor.fetchall()],
                        updated_at,
                    )
            space.update_time = updated_at.isoformat()

    def _replace_domains(self, cursor: Any, space: Space) -> list[str]:
        """Write the Space's domains and return the IDs of renamed domains."""
        cursor.execute("SELECT id, domain FROM domains WHERE space_id = %s", (space.space_id,))
        existing = {row["id"]: row["domain"] for row in cursor.fetchall()}
        names = {name: domain_id for domain_id, name in existing.items()}
        tracked = space.domain_ids if isinstance(space, _StoredSpace) else {}
        seen = set()
        renamed = []
        for domain in space.domains:
            domain_id = tracked.get(id(domain)) or names.get(domain.name) or str(uuid4())
            seen.add(domain_id)
            cursor.execute(
                """INSERT INTO domains (id, space_id, domain, description) VALUES (%s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET domain = EXCLUDED.domain,
                       description = EXCLUDED.description, update_time = clock_timestamp()""",
                (domain_id, space.space_id, domain.name, domain.description),
            )
            if domain_id in existing and existing[domain_id] != domain.name:
                renamed.append(domain_id)
                # Unfinished and staged Episodes keep their candidate domains by name.
                cursor.execute(
                    """UPDATE add_jobs SET domains = array_replace(domains, %s, %s),
                          organize_result = CASE
                              WHEN organize_result->'staged'->>'domain' = %s
                              THEN jsonb_set(organize_result, '{staged,domain}', to_jsonb(%s::text))
                              ELSE organize_result END
                       WHERE space_id = %s AND outcome IN ('pending', 'staged')""",
                    (
                        existing[domain_id],
                        domain.name,
                        existing[domain_id],
                        domain.name,
                        space.space_id,
                    ),
                )
        missing = list(existing.keys() - seen)
        if missing:
            cursor.execute(
                "SELECT domain_id FROM topics WHERE space_id = %s AND domain_id = ANY(%s)",
                (space.space_id, missing),
            )
            if cursor.fetchone():
                raise ValueError("领域仍被主题引用，不能删除")
            cursor.execute(
                """UPDATE add_jobs SET organize_result = jsonb_set(
                          organize_result, '{staged,domain}', 'null'::jsonb)
                   WHERE space_id = %s AND organize_result->'staged'->>'domain' = ANY(%s)""",
                (space.space_id, [existing[domain_id] for domain_id in missing]),
            )
            cursor.execute(
                "DELETE FROM domains WHERE space_id = %s AND id = ANY(%s)",
                (space.space_id, missing),
            )
        return renamed

    def _clear_topics(self, cursor: Any, space_id: str, now: Any) -> list[str]:
        """Record clear_time, reset Formation, fail the unfinished Episodes, retire the staged
        ones and delete the Topics (entries cascade, episodes.topic_id is set NULL)."""
        cursor.execute(
            """UPDATE spaces SET clear_time = %s, last_formation_time = NULL,
                      formation_version = formation_version + 1
               WHERE id = %s RETURNING project_id""",
            (now, space_id),
        )
        project_id = cursor.fetchone()["project_id"]
        error = {"reason": "SPACE_CLEARED", "message": "Space was cleared"}
        cursor.execute(
            """WITH pending AS (
                   SELECT episode_id, stage FROM add_jobs
                   WHERE space_id = %s AND outcome = 'pending' FOR UPDATE
               )
               UPDATE add_jobs j SET stage = 'done', outcome = 'failed', close_due_time = NULL,
                      next_retry_time = NULL, update_time = %s, error = %s,
                      organize_result = CASE WHEN pending.stage = 'episode_open'
                          THEN COALESCE(j.organize_result, '{}'::jsonb) || jsonb_build_object(
                              'close', jsonb_build_object('reason', 'space_cleared',
                                                          'at', %s::text))
                          ELSE j.organize_result END
               FROM pending WHERE j.episode_id = pending.episode_id
               RETURNING j.episode_id AS id, j.attempt, pending.stage AS previous_stage""",
            (space_id, now, json_value(error), now.isoformat()),
        )
        for row in cursor.fetchall():
            if row["previous_stage"] == "episode_open":
                record_event(
                    cursor,
                    None,
                    row["id"],
                    "closed",
                    now,
                    detail={"reason": "space_cleared"},
                )
            record_event(
                cursor,
                None,
                row["id"],
                "finished",
                now,
                stage="done",
                attempt=row["attempt"],
                detail={"outcome": "failed", "reason": "SPACE_CLEARED"},
            )
        cursor.execute(
            """UPDATE add_jobs SET outcome = 'skipped', update_time = %s,
                      organize_result = jsonb_set(organize_result, '{staged,status}',
                                                  '"archived"'::jsonb)
               WHERE space_id = %s AND outcome = 'staged'""",
            (now, space_id),
        )
        cursor.execute("DELETE FROM topics WHERE space_id = %s RETURNING id", (space_id,))
        removed = sorted(row["id"] for row in cursor.fetchall())
        if self.store.retrieval_index:
            # clear_time hides every snapshot accepted before the clear.
            sync_space(cursor, project_id, space_id)
        return removed

    def clear_space_topics(self, space_id: str) -> list[str]:
        with self.store.transaction() as cursor:
            cursor.execute(
                "SELECT clock_timestamp() AS cleared_at FROM spaces WHERE id = %s FOR UPDATE",
                (space_id,),
            )
            row = cursor.fetchone()
            if row is None:
                raise LookupError("Space 不存在")
            return self._clear_topics(cursor, space_id, row["cleared_at"])

    def delete_space_nodes(self, space_id: str) -> int:
        with self.store.transaction() as cursor:
            cursor.execute("DELETE FROM spaces WHERE id = %s RETURNING project_id", (space_id,))
            removed = cursor.fetchall()
            if removed and self.store.retrieval_index:
                sync_space(cursor, removed[0]["project_id"], space_id)
            return len(removed)

    def _topic_by_id(self, topic_id: str, space_id: str | None = None) -> dict[str, Any] | None:
        with self.store.transaction(readonly=True) as cursor:
            rows = load_topics(
                cursor,
                "t.id = %s AND (%s::text IS NULL OR t.space_id = %s)",
                (topic_id, space_id, space_id),
            )
            return rows[0] if rows else None

    def get_topic(self, topic_id: str, space_id: str | None = None) -> Topic | None:
        row = self._topic_by_id(topic_id, space_id)
        return _topic(row) if row else None

    def list_topics(self, space_id: str) -> list[Topic]:
        return [_topic(row) for row in self.store.read_topics(space_id)]

    def put_topic(self, topic: Topic, touch: bool = True) -> None:
        """Keep the existing domain-update operation working on relational Topic rows."""
        with self.store.transaction() as cursor:
            cursor.execute(
                """UPDATE topics t SET domain_id = d.id,
                     update_time = CASE WHEN %s THEN clock_timestamp() ELSE t.update_time END
                   FROM domains d
                   WHERE t.space_id = %s AND t.id = %s AND d.space_id = t.space_id AND d.domain = %s""",
                (touch, topic.space_id, topic.id, topic.domain),
            )

    def delete_topic(self, topic: Topic) -> None:
        with self.store.transaction() as cursor:
            cursor.execute(
                "DELETE FROM topics WHERE space_id = %s AND id = %s", (topic.space_id, topic.id)
            )
            if self.store.retrieval_index and cursor.rowcount:
                self._retract(cursor, topic.space_id, [topic.id])

    def delete_topics(self, space_id: str, topic_ids: list[str]) -> list[str]:
        if not topic_ids:
            return self.clear_space_topics(space_id)
        with self.store.transaction() as cursor:
            cursor.execute("SELECT id FROM spaces WHERE id = %s FOR UPDATE", (space_id,))
            if cursor.fetchone() is None:
                raise LookupError("Space 不存在")
            cursor.execute(
                "DELETE FROM topics WHERE space_id = %s AND id = ANY(%s::text[]) RETURNING id",
                (space_id, topic_ids),
            )
            removed = {row["id"] for row in cursor.fetchall()}
            missing = set(topic_ids) - removed
            if missing:
                raise LookupError(f"主题不在这个 Space 里：{sorted(missing)}")
            if self.store.retrieval_index:
                self._retract(cursor, space_id, sorted(removed))
            return sorted(removed)

    def _retract(self, cursor: Any, space_id: str, topic_ids: list[str]) -> None:
        cursor.execute(
            "SELECT project_id, clock_timestamp() AS now FROM spaces WHERE id = %s", (space_id,)
        )
        row = cursor.fetchone()
        retract_topics(cursor, row["project_id"], space_id, topic_ids, row["now"])

    def delete_index(self, key: str) -> None:
        """Indexes are derived by the database and cleared with their authoritative rows."""

    def _scoped_component(self, memory_id: str) -> dict[str, Any] | None:
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT i.entry_type AS kind, i.topic_id, i.space_id FROM project_entries i
                   WHERE i.id = %s AND i.parent_decision_id IS NULL""",
                (memory_id,),
            )
            return cursor.fetchone()

    def get_index(self, key: str) -> dict[str, Any] | None:
        kind, _, identifier = key.partition(":")
        if kind == "timeline":
            row = self._scoped_component(identifier)
            if row and row["kind"] == "timeline":
                return {"space_id": row["space_id"], "topic_id": row["topic_id"]}
        if kind == "conv":
            with self.store.transaction(readonly=True) as cursor:
                cursor.execute(
                    """SELECT DISTINCT space_id FROM add_jobs
                       WHERE conversation_key = %s ORDER BY space_id""",
                    (identifier,),
                )
                spaces = {row["space_id"] for row in cursor.fetchall()}
            if self.legacy:
                for space in (self.legacy.get_index(key) or {}).get("space_ids", []):
                    if self._legacy_allowed(space):
                        spaces.add(space)
            return {"space_ids": sorted(spaces)}
        return None

    def _legacy_allowed(self, space_id: str) -> bool:
        row = self.store.read_space(space_id)
        return row is not None and row["cleared_at"] is None

    def legacy_task_status(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        if self.legacy is None or task_id not in self.legacy.nodes:
            return None
        remembered = self.legacy.nodes[task_id]["metadata"].get("memory_ids") or []
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT t.id FROM topics t JOIN spaces s ON s.id = t.space_id
                   WHERE s.clear_time IS NULL AND t.id = ANY(%s::text[])""",
                (remembered,),
            )
            visible = {row["id"] for row in cursor.fetchall()}
        return self.legacy.task_status(task_id, user_id, self._legacy_allowed, visible)

    def find_node(self, memory_id: str) -> dict[str, Any] | None:
        """Adapt the component projection to the existing by-ID result dispatcher."""
        row = self._scoped_component(memory_id)
        if row and row["kind"] in ("experience", "decision"):
            return {
                "id": memory_id,
                "metadata": {
                    "user_name": row["space_id"],
                    "memory_type": PROJECT_DECISION
                    if row["kind"] == "decision"
                    else PROJECT_EXPERIENCE,
                },
            }
        if self.legacy:
            node = self.legacy.find_node(memory_id)
            if node and self._legacy_allowed(node["metadata"].get("user_name", "")):
                return node
        return None

    def list_decisions(self, space_id: str, topic_id: str | None = None) -> list[Decision]:
        rows = self.store.read_topics(space_id, topic_ids=[topic_id] if topic_id else None)
        return [_decision(row, item) for row in rows for item in row["decisions"]]

    def get_decision(self, decision_id: str, space_id: str) -> Decision | None:
        row = self._scoped_component(decision_id)
        if row and row["space_id"] == space_id and row["kind"] == "decision":
            return next(
                (
                    item
                    for item in self.list_decisions(space_id, row["topic_id"])
                    if item.id == decision_id
                ),
                None,
            )
        return None

    def list_experiences(
        self, space_id: str, include_archived: bool = False
    ) -> list[ExperienceCard]:
        rows = self.store.read_topics(space_id)
        return [
            _experience(row, item)
            for row in rows
            for item in row["experiences"]
            if include_archived or not experience_retired(item)
        ]

    def get_experience(self, experience_id: str, space_id: str) -> ExperienceCard | None:
        row = self._scoped_component(experience_id)
        if row and row["space_id"] == space_id and row["kind"] == "experience":
            topics = self.store.read_topics(space_id, topic_ids=[row["topic_id"]])
            return next(
                (
                    _experience(topic, item)
                    for topic in topics
                    for item in topic["experiences"]
                    if item["id"] == experience_id
                ),
                None,
            )
        if self.legacy and self._legacy_allowed(space_id):
            return self.legacy.get_experience(experience_id, space_id)
        return None

    def recall_topics(
        self, space_id: str, text: str, top_k: int, domains: list[str] | None = None
    ) -> list[tuple[float, Topic]]:
        rows = self.store.read_topics(space_id, domains or None)
        embedding = None
        if self.embedder and rows:
            with contextlib.suppress(Exception):
                embedding = self.embedder([text])[0]
        ranked = []
        for row in rows:
            topic = _topic(row)
            score = lexical_sim(text, topic.index_text)
            if embedding and row["embedding"]:
                vector = [float(part) for part in row["embedding"].strip("[]").split(",")]
                if len(vector) == len(embedding):
                    score = max(score, cosine(vector, embedding))
            ranked.append((score, topic))
        return sorted(ranked, key=lambda entry: (-entry[0], entry[1].id))[:top_k]

    def list_messages(self, space_id: str, conversation_id: str) -> list[Msg]:
        with self.store.transaction(readonly=True) as cursor:
            # The conversation's messages that some Episode of this Space covers.
            cursor.execute(
                """SELECT m.* FROM messages m
                   WHERE m.conversation_key = %s AND EXISTS (
                       SELECT 1 FROM episodes e JOIN add_jobs j ON j.episode_id = e.id
                       WHERE e.space_id = %s AND e.conversation_key = m.conversation_key
                         AND j.project_id = m.project_id
                         AND m.msg_seq BETWEEN e.message_seq_start AND e.message_seq_end)
                   ORDER BY m.msg_seq""",
                (conversation_id, space_id),
            )
            rows = cursor.fetchall()
        calls = {call["id"]: call["function"] for row in rows for call in row["tool_calls"] or []}
        messages = []
        for row in rows:
            tool = calls.get(row["tool_call_id"], {})
            messages.append(
                Msg(
                    id=row["message_id"],
                    role={"user": "member", "assistant": "agent"}.get(row["role"], row["role"]),
                    text=row["content"],
                    chat_time=row["chat_time"].isoformat(),
                    user_id=row["role_id"] or "",
                    name=row["role_name"] or "",
                    tool_name=tool.get("name", ""),
                    tool_args=tool.get("arguments", ""),
                    tool_call_id=row["tool_call_id"] or "",
                    notes=row["experience_notes"] or [],
                    seq=row["msg_seq"],
                    node_id=row["message_id"],
                )
            )
        if self.legacy and self._legacy_allowed(space_id):
            ids = {item.id for item in messages}
            messages.extend(
                item
                for item in self.legacy.list_messages(space_id, conversation_id)
                if item.id not in ids
            )
            messages.sort(key=lambda item: (item.chat_time, item.seq))
        return messages
