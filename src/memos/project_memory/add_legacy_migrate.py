"""Preflight and import a stopped legacy project memory store into the Add schema."""

from __future__ import annotations

import argparse
import json
import os
import sys

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .add_acceptance import AcceptanceSettings
from .add_commit import refresh_topic_items
from .add_legacy import LegacyArchive, read_legacy_postgres, read_legacy_sqlite
from .add_legacy_episodes import rebuild_legacy_trajectories, recorded_time
from .add_store import PostgresAddStore, json_value
from .config import postgres_config
from .types import (
    PROJECT_DECISION,
    PROJECT_EXPERIENCE,
    PROJECT_SPACE,
    PROJECT_TOPIC,
    ExperienceCard,
    stable_uuid,
)


@dataclass
class MigrationPlan:
    archive: LegacyArchive
    spaces: list[dict[str, Any]] = field(default_factory=list)
    domains: list[dict[str, Any]] = field(default_factory=list)
    topics: list[dict[str, Any]] = field(default_factory=list)
    episodes: list[dict[str, Any]] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)
    episode_turns: list[dict[str, Any]] = field(default_factory=list)
    exceptions: list[dict[str, str]] = field(default_factory=list)

    def report(self) -> dict[str, Any]:
        return {
            "project_id": self.archive.project_id,
            "source_sha256": self.archive.digest,
            "source_counts": dict(
                Counter(node["metadata"].get("memory_type") for node in self.archive.nodes.values())
            ),
            "counts": {name: len(getattr(self, name)) for name in _TABLES},
            "archive_only": self.exceptions,
        }


def _topic_row(node: dict[str, Any], domains: dict[tuple[str, str], str]) -> dict[str, Any]:
    meta = node["metadata"]
    space = meta["user_name"]
    domain = domains.get((space, meta.get("domain")))
    if domain is None:
        raise ValueError("Topic domain is absent from the legacy Space")
    timeline = meta.get("timeline") or []
    return {
        "id": node["id"],
        "space_id": space,
        "domain_id": domain,
        "topic_name": meta.get("topic_name") or node["memory"],
        "topic_summary": meta.get("topic_summary") or "",
        "topic_description": meta.get("topic_description") or "",
        "create_time": recorded_time(meta.get("create_time"), meta.get("created_at")),
        "update_time": recorded_time(meta.get("update_time"), meta.get("updated_at")),
        "decisions": [],
        "experiences": [],
        "timeline": [item for item in timeline if item.get("id")],
        "sources": meta.get("topic_sources") or [],
    }


def _archive_only(plan: MigrationPlan, id_: str, kind: str, reason: str) -> None:
    plan.exceptions.append({"id": id_, "kind": kind, "reason": reason})


def _migrate_experience(
    plan: MigrationPlan, node: dict[str, Any], topics: dict[str, dict[str, Any]]
) -> None:
    identifier = node["id"]
    meta = node["metadata"]
    card = ExperienceCard.from_node(identifier, meta)
    if card.node_status == "archived":
        return
    matched_topics = [
        topic
        for topic in dict.fromkeys(card.topic_ids)
        if topic in topics and topics[topic]["space_id"] == card.space_id
    ]
    if not matched_topics:
        plan.archive.fallback_experiences.add(identifier)
        _archive_only(plan, identifier, "experience", "original related Topic is unavailable")
        return
    history = []
    for old in card.history:
        archive_id = old.get("archived_memory_id")
        old_node = plan.archive.nodes.get(archive_id)
        entry = dict(old)
        if old_node and old_node["metadata"].get("user_name") == card.space_id:
            entry["card"] = ExperienceCard.from_node(archive_id, old_node["metadata"]).card()
        history.append(entry)
    target = topics[matched_topics[-1]]
    target["experiences"].append(
        {
            "id": identifier,
            "version": card.version,
            "status": card.exp_status,
            "confidence": card.confidence,
            "quality_score": card.quality_score,
            "signal": card.signal,
            "time": card.time,
            "last_supported_at": card.last_supported_at,
            "session_id": card.session_id,
            "user_id": card.user_id,
            "user_ids": card.author_ids,
            "use_count": card.use_count,
            "card": card.card(),
            "sources": card.sources,
            "history": history,
            "legacy_topic_ids": matched_topics[:-1],
        }
    )


def plan_migration(
    nodes: list[dict[str, Any]], space_projects: dict[str, str], project_id: str
) -> MigrationPlan:
    """Build a side-effect free migration plan from an immutable source snapshot."""
    source_spaces = {
        node["id"] for node in nodes if node["metadata"].get("memory_type") == PROJECT_SPACE
    }
    if source_spaces - space_projects.keys() or any(
        not project for project in space_projects.values()
    ):
        raise ValueError("Every legacy Space requires an explicit trusted project mapping")
    archive = LegacyArchive(project_id, nodes, space_projects, set())
    plan = MigrationPlan(archive)
    spaces = {}
    topics = {}
    domains = {}
    for node in archive.nodes.values():
        meta = node["metadata"]
        if meta.get("memory_type") != PROJECT_SPACE:
            continue
        identifier = node["id"]
        configured = meta.get("domains") or []
        try:
            row = {
                "id": identifier,
                "project_id": project_id,
                "space_name": meta.get("space_name") or node["memory"],
                "instructions": meta.get("instructions") or "",
                "create_time": recorded_time(meta.get("create_time"), meta.get("created_at")),
                "update_time": recorded_time(meta.get("update_time"), meta.get("updated_at")),
            }
        except ValueError as error:
            _archive_only(plan, identifier, "space", str(error))
            continue
        spaces[identifier] = {
            **row,
            "domain_names": [domain["name"] for domain in configured],
            "legacy_epoch": meta.get("epoch") or 0,
        }
        plan.spaces.append(row)
        for domain in configured:
            name = domain["name"]
            domain_id = stable_uuid(f"project-domain:{identifier}:{name}")
            domains[(identifier, name)] = domain_id
            plan.domains.append(
                {
                    "id": domain_id,
                    "space_id": identifier,
                    "domain": name,
                    "description": domain.get("description") or "",
                }
            )
    for node in archive.nodes.values():
        if node["metadata"].get("memory_type") != PROJECT_TOPIC:
            continue
        try:
            row = _topic_row(node, domains)
        except ValueError as error:
            _archive_only(plan, node["id"], "topic", str(error))
            continue
        topics[node["id"]] = row
        if len(row["timeline"]) != len(node["metadata"].get("timeline") or []):
            _archive_only(
                plan, node["id"], "timeline", "entries without original IDs retained in source"
            )
    for node in archive.nodes.values():
        meta = node["metadata"]
        if meta.get("memory_type") == PROJECT_EXPERIENCE:
            _migrate_experience(plan, node, topics)
        if meta.get("memory_type") == PROJECT_DECISION:
            project = meta.get("project") or {}
            target = topics.get(project.get("topic_id") or meta.get("topic_id"))
            if not target or target["space_id"] != meta.get("user_name"):
                _archive_only(
                    plan, node["id"], "decision", "original decision Topic is unavailable"
                )
                continue
            target["decisions"].append(
                {**project, "id": node["id"], "content": project.get("content") or node["memory"]}
            )
    plan.topics = list(topics.values())
    plan.episodes, plan.messages, plan.episode_turns = rebuild_legacy_trajectories(
        archive.nodes, spaces, topics, project_id, AcceptanceSettings.from_env(), plan.exceptions
    )
    return plan


_TABLES = ("spaces", "domains", "topics", "messages", "episodes", "episode_turns")
_JSON_COLUMNS = {
    "decisions",
    "experiences",
    "timeline",
    "sources",
    "tool_calls",
    "experience_notes",
    "agent_id",
    "result",
}


def _insert_rows(cursor: Any, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    columns = tuple(rows[0])
    placeholders = ", ".join("%s" for _ in columns)
    # Table names and columns come from the plan builder, not the legacy source.
    cursor.executemany(
        f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})",
        [
            tuple(json_value(row[col]) if col in _JSON_COLUMNS else row[col] for col in columns)
            for row in rows
        ],
    )


def apply_migration(store: PostgresAddStore, plan: MigrationPlan) -> None:
    if store.project_id != plan.archive.project_id:
        raise ValueError("Migration target project does not match the archive scope")
    with store.transaction() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (json.dumps([store.schema_name, store.project_id, "legacy-migration"]),),
        )
        cursor.execute(
            "SELECT id FROM spaces WHERE id = ANY(%s::text[])",
            ([space["id"] for space in plan.spaces],),
        )
        if cursor.fetchone() is not None:
            raise ValueError(
                "Legacy Space already exists in the destination; import would overwrite data"
            )
        for table in _TABLES:
            _insert_rows(cursor, table, getattr(plan, table))
        for topic in plan.topics:
            index_text = "\n".join(
                topic[key] for key in ("topic_name", "topic_summary", "topic_description")
            )
            cursor.execute(
                "UPDATE topics SET search_tsv = to_tsvector('simple', %s) WHERE id = %s",
                (index_text, topic["id"]),
            )
            refresh_topic_items(cursor, topic, 1)
        for source in plan.messages:
            cursor.execute(
                """SELECT content_sha256 FROM messages WHERE project_id = %s AND
                   conversation_key = %s AND message_id = %s""",
                (store.project_id, source["conversation_key"], source["message_id"]),
            )
            if cursor.fetchone()["content_sha256"] != source["content_sha256"]:
                raise ValueError("Migration source digest verification failed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--legacy-sqlite", type=Path, help="stopped legacy SQLite snapshot")
    source.add_argument(
        "--legacy-postgres-env", help="environment name holding the read-only source DSN"
    )
    parser.add_argument("--source-schema", default="project_memory")
    parser.add_argument(
        "--mapping",
        type=Path,
        required=True,
        help="JSON object mapping legacy Space IDs to trusted project IDs",
    )
    parser.add_argument("--project-id", required=True)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="apply plan to configured PROJECT_MEMORY_POSTGRES destination",
    )
    parser.add_argument(
        "--archive",
        type=Path,
        help="required with apply; read-only scoped snapshot for historical lookups",
    )
    args = parser.parse_args()
    if args.apply and args.archive is None:
        parser.error("--apply requires an --archive path")
    with args.mapping.open(encoding="utf-8") as file:
        scope = json.load(file)
    nodes = (
        read_legacy_sqlite(args.legacy_sqlite)
        if args.legacy_sqlite
        else read_legacy_postgres(os.environ[args.legacy_postgres_env], args.source_schema)
    )
    plan = plan_migration(nodes, scope, args.project_id)
    if args.apply:
        if args.archive.exists():
            if LegacyArchive.read(args.archive, args.project_id).digest != plan.archive.digest:
                parser.error("archive is occupied by a different snapshot")
        else:
            plan.archive.write(args.archive)
        store = PostgresAddStore(postgres_config(), project_id=args.project_id)
        try:
            apply_migration(store, plan)
        finally:
            store.close()
    sys.stdout.write(json.dumps({**plan.report(), "applied": args.apply}, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
