"""Read-only sources and compatibility reads for project-memory migration."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3

from collections import defaultdict
from contextlib import closing
from typing import TYPE_CHECKING, Any

from .graph_store import ProjectStore
from .types import PROJECT_EXPERIENCE, PROJECT_MESSAGE, PROJECT_TASK, ExperienceCard, TaskRecord


if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from .types import Msg


def _legacy_row(node_id: str, properties: str | dict[str, Any]) -> dict[str, Any]:
    metadata = json.loads(properties) if isinstance(properties, str) else dict(properties)
    return {"id": node_id, "memory": metadata.pop("memory", ""), "metadata": metadata}


def read_legacy_sqlite(path: Path) -> list[dict[str, Any]]:
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)) as source:
        source.execute("BEGIN")
        return [
            _legacy_row(*row)
            for row in source.execute("SELECT id, properties FROM memory ORDER BY seq, id")
        ]


def read_legacy_postgres(dsn: str, schema: str) -> list[dict[str, Any]]:
    try:
        from psycopg2 import connect, sql
    except ImportError as exc:
        raise ImportError(
            "Project memory migration requires the psycopg2 PostgreSQL driver"
        ) from exc
    with closing(connect(dsn)) as source:
        source.set_session(readonly=True, isolation_level="REPEATABLE READ")
        with source.cursor() as cursor:
            cursor.execute(
                sql.SQL("SELECT id, properties FROM {}.memory ORDER BY seq, id").format(
                    sql.Identifier(schema)
                )
            )
            return [_legacy_row(*row) for row in cursor.fetchall()]


class LegacyArchive:
    """Retain legacy source facts and provide narrowly scoped history lookups."""

    def __init__(
        self,
        project_id: str,
        nodes: list[dict[str, Any]],
        space_projects: dict[str, str],
        fallback_experiences: set[str],
    ) -> None:
        self.project_id = project_id
        self.space_projects = dict(space_projects)
        self.nodes = {}
        for node in nodes:
            if node["id"] in self.nodes:
                raise ValueError("Duplicate node identifier in legacy archive")
            metadata = node["metadata"]
            if metadata.get("memory_type") == PROJECT_TASK:
                scope = metadata.get("space_ids") or []
                if not scope or any(
                    self.space_projects.get(space_id) != project_id for space_id in scope
                ):
                    continue
            elif self.space_projects.get(metadata.get("user_name")) != project_id:
                continue
            self.nodes[node["id"]] = node
        self.fallback_experiences = fallback_experiences.intersection(self.nodes)
        self._messages: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        self._spaces_by_conversation: dict[str, set[str]] = defaultdict(set)
        for node in self.nodes.values():
            metadata = node["metadata"]
            if metadata.get("memory_type") == PROJECT_MESSAGE:
                conversation = metadata.get("conversation_id") or ""
                space_id = metadata["user_name"]
                self._messages[(space_id, conversation)].append(node)
                self._spaces_by_conversation[conversation].add(space_id)

    def _payload(self) -> dict[str, Any]:
        return {
            "version": 1,
            "project_id": self.project_id,
            "space_projects": {
                space: project
                for space, project in self.space_projects.items()
                if project == self.project_id
            },
            "nodes": [self.nodes[node_id] for node_id in sorted(self.nodes)],
            "fallback_experiences": sorted(self.fallback_experiences),
        }

    @property
    def digest(self) -> str:
        return hashlib.sha256(
            json.dumps(self._payload(), sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()

    def write(self, path: Path) -> None:
        """Write a new archive with owner-only permissions."""
        with os.fdopen(
            os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8"
        ) as file:
            json.dump({**self._payload(), "sha256": self.digest}, file, ensure_ascii=False)
            file.write("\n")

    @classmethod
    def read(cls, path: Path, project_id: str) -> LegacyArchive:
        with path.open(encoding="utf-8") as file:
            payload = json.load(file)
        if payload["project_id"] != project_id or payload["version"] != 1:
            raise ValueError("Legacy archive version or project scope does not match")
        archive = cls(
            project_id,
            payload["nodes"],
            payload["space_projects"],
            set(payload["fallback_experiences"]),
        )
        if archive.digest != payload["sha256"]:
            raise ValueError("Legacy archive digest does not match")
        return archive

    def find_node(self, node_id: str) -> dict[str, Any] | None:
        if node_id not in self.fallback_experiences:
            return None
        node = self.nodes[node_id]
        return node if node["metadata"].get("memory_type") == PROJECT_EXPERIENCE else None

    def get_experience(self, node_id: str, space_id: str) -> ExperienceCard | None:
        node = self.find_node(node_id)
        if node and node["metadata"].get("user_name") == space_id:
            return ExperienceCard.from_node(node_id, node["metadata"])
        return None

    def get_index(self, key: str) -> dict[str, Any] | None:
        if key.startswith("conv:"):
            return {"space_ids": sorted(self._spaces_by_conversation.get(key[5:], set()))}
        return None

    def list_messages(self, space_id: str, conversation_id: str) -> list[Msg]:
        messages = [
            ProjectStore._to_msg(node) for node in self._messages[(space_id, conversation_id)]
        ]
        return sorted(messages, key=lambda message: (message.seq, message.chat_time, message.id))

    def task_status(
        self,
        task_id: str,
        user_id: str,
        space_allowed: Callable[[str], bool],
        visible_topic_ids: set[str],
    ) -> dict[str, Any] | None:
        node = self.nodes.get(task_id)
        if not node or node["metadata"].get("memory_type") != PROJECT_TASK:
            return None
        task = TaskRecord.from_props(node["metadata"])
        if (
            task.user_id != user_id
            or not task.space_ids
            or not all(map(space_allowed, task.space_ids))
        ):
            return None
        task.memory_ids = [topic for topic in task.memory_ids if topic in visible_topic_ids]
        if task.status == "in_progress":
            task.status = "failed"
            task.error = "Legacy task was archived before processing finished"
        return task.to_api()
