"""Expose the existing project read and management operations over Add's authoritative tables."""

from __future__ import annotations

import contextlib

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from .add_store import json_value
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
            "user_id": item.get("user_id") or "",
            "session_id": item.get("session_id") or "",
            "confidence": item.get("confidence", 0.5),
            "version": item.get("version", 1),
            "topic_ids": list(dict.fromkeys([*item.get("legacy_topic_ids", []), row["id"]])),
            "anchors": card.get("anchors", []),
            "info": {
                **card,
                "exp_status": item.get("status", "candidate"),
                "quality_score": item.get("quality_score"),
                "signal": item.get("signal"),
                "author_ids": item.get("user_ids") or [],
                "time": item.get("time") or "",
                "last_supported_at": item.get("last_supported_at") or "",
                "use_count": item.get("use_count", 0),
            },
            "status": "archived" if item.get("archived") else "activated",
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
                   WHERE s.project_id = %s AND s.id = %s GROUP BY s.id""",
                (self.store.project_id, space_id),
            )
            row = cursor.fetchone()
        if row is None:
            return None
        domains = [
            Domain(domain["name"], domain["description"]) for domain in row["configured_domains"]
        ]
        return _StoredSpace(
            space_id=row["id"],
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
                cursor.execute(
                    """INSERT INTO spaces (id, project_id, space_name, instructions, create_time, update_time)
                       VALUES (%s, %s, %s, %s, %s, clock_timestamp()) RETURNING update_time""",
                    (
                        space.space_id,
                        self.store.project_id,
                        space.space_name,
                        space.instructions,
                        space.create_time,
                    ),
                )
            else:
                if current["project_id"] != self.store.project_id:
                    raise LookupError("Space 不存在")
                if (
                    isinstance(space, _StoredSpace)
                    and space.update_time != current["update_time"].isoformat()
                ):
                    raise ValueError(
                        "Space changed while updating it; retry with the current Space"
                    )
                cursor.execute(
                    """UPDATE spaces SET space_name = %s, instructions = %s, update_time = clock_timestamp()
                       WHERE project_id = %s AND id = %s RETURNING update_time""",
                    (space.space_name, space.instructions, self.store.project_id, space.space_id),
                )
            updated_at = cursor.fetchone()["update_time"]
            self._replace_domains(cursor, space)
            space.update_time = updated_at.isoformat()

    def _replace_domains(self, cursor: Any, space: Space) -> None:
        cursor.execute("SELECT id, domain FROM domains WHERE space_id = %s", (space.space_id,))
        existing = {row["id"]: row["domain"] for row in cursor.fetchall()}
        names = {name: domain_id for domain_id, name in existing.items()}
        tracked = space.domain_ids if isinstance(space, _StoredSpace) else {}
        seen = set()
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
                cursor.execute(
                    """UPDATE episodes SET domains = array_replace(domains, %s, %s)
                       WHERE project_id = %s AND space_id = %s AND outcome = 'pending'""",
                    (existing[domain_id], domain.name, self.store.project_id, space.space_id),
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
                """UPDATE episodes SET staged_domain_id = NULL
                   WHERE project_id = %s AND space_id = %s AND staged_domain_id = ANY(%s)""",
                (self.store.project_id, space.space_id, missing),
            )
            cursor.execute(
                "DELETE FROM domains WHERE space_id = %s AND id = ANY(%s)",
                (space.space_id, missing),
            )

    def _clear_topics(self, cursor: Any, space_id: str, now: Any) -> list[str]:
        cursor.execute(
            """UPDATE spaces SET cleared_at = %s, last_formation_at = NULL,
                                 staged_since_last_formation = 0, formation_version = formation_version + 1
               WHERE project_id = %s AND id = %s""",
            (now, self.store.project_id, space_id),
        )
        cursor.execute(
            """UPDATE episodes SET state = CASE WHEN state = 'open' THEN 'closed' ELSE state END,
                      stage = 'done', outcome = 'failed', closed_at = COALESCE(closed_at, %s),
                      updated_at = %s, error = %s
               WHERE project_id = %s AND space_id = %s AND outcome = 'pending'""",
            (
                now,
                now,
                json_value({"reason": "SPACE_CLEARED", "message": "Space was cleared"}),
                self.store.project_id,
                space_id,
            ),
        )
        cursor.execute(
            """UPDATE episodes SET staged_status = 'archived', updated_at = %s
               WHERE project_id = %s AND space_id = %s AND staged_status = 'active'""",
            (now, self.store.project_id, space_id),
        )
        cursor.execute("DELETE FROM topics WHERE space_id = %s RETURNING id", (space_id,))
        return sorted(row["id"] for row in cursor.fetchall())

    def clear_space_topics(self, space_id: str) -> list[str]:
        with self.store.transaction() as cursor:
            cursor.execute(
                "SELECT clock_timestamp() AS cleared_at FROM spaces WHERE project_id = %s AND id = %s FOR UPDATE",
                (self.store.project_id, space_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise LookupError("Space 不存在")
            return self._clear_topics(cursor, space_id, row["cleared_at"])

    def delete_space_nodes(self, space_id: str) -> int:
        with self.store.transaction() as cursor:
            cursor.execute(
                "DELETE FROM spaces WHERE project_id = %s AND id = %s",
                (self.store.project_id, space_id),
            )
            return cursor.rowcount

    def _topic_by_id(self, topic_id: str, space_id: str | None = None) -> dict[str, Any] | None:
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT t.*, d.domain FROM topics t JOIN spaces s ON s.id = t.space_id
                     JOIN domains d ON d.id = t.domain_id AND d.space_id = t.space_id
                   WHERE s.project_id = %s AND t.id = %s AND (%s::text IS NULL OR t.space_id = %s)""",
                (self.store.project_id, topic_id, space_id, space_id),
            )
            return cursor.fetchone()

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
                   FROM spaces s, domains d WHERE s.project_id = %s AND s.id = t.space_id
                     AND t.space_id = %s AND t.id = %s AND d.space_id = s.id AND d.domain = %s""",
                (touch, self.store.project_id, topic.space_id, topic.id, topic.domain),
            )

    def delete_topic(self, topic: Topic) -> None:
        with self.store.transaction() as cursor:
            cursor.execute(
                """DELETE FROM topics t USING spaces s WHERE s.project_id = %s AND s.id = t.space_id
                     AND t.space_id = %s AND t.id = %s""",
                (self.store.project_id, topic.space_id, topic.id),
            )

    def delete_topics(self, space_id: str, topic_ids: list[str]) -> list[str]:
        if not topic_ids:
            return self.clear_space_topics(space_id)
        with self.store.transaction() as cursor:
            cursor.execute(
                "SELECT id FROM spaces WHERE project_id = %s AND id = %s FOR UPDATE",
                (self.store.project_id, space_id),
            )
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
            return sorted(removed)

    def delete_index(self, key: str) -> None:
        """Indexes are derived by the database and cleared with their authoritative rows."""

    def _scoped_component(self, memory_id: str) -> dict[str, Any] | None:
        with self.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT i.kind, i.topic_id, i.space_id FROM topic_items i
                     JOIN spaces s ON s.id = i.space_id
                   WHERE s.project_id = %s AND i.id = %s""",
                (self.store.project_id, memory_id),
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
                    """SELECT DISTINCT space_id FROM episode_turns
                       WHERE project_id = %s AND conversation_key = %s ORDER BY space_id""",
                    (self.store.project_id, identifier),
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
                   WHERE s.project_id = %s AND s.cleared_at IS NULL AND t.id = ANY(%s::text[])""",
                (self.store.project_id, remembered),
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
            if include_archived or not item.get("archived")
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
            cursor.execute(
                """SELECT m.* FROM episode_turns et JOIN messages m USING (project_id, conversation_key, turn_id)
                   WHERE et.project_id = %s AND et.space_id = %s AND et.conversation_key = %s
                   ORDER BY m.turn_seq, m.msg_seq, m.message_id""",
                (self.store.project_id, space_id, conversation_id),
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
                    seq=row["turn_seq"],
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
