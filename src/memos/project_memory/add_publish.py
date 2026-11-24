"""Publish committed Add Topics into the shared retrieval index.

The retrieval read path (`index`, `store`, `retrieval`) reads only `memos_project.pm_retrieval_*`
and the space registry `memos_project.pm_spaces / pm_domains`. Add keeps its authoritative tables
in its own schema; this module mirrors Spaces, Domains and committed Topics into those tables in
the same transaction as each Add write, so a search never sees a state Add has not committed.
"""

from __future__ import annotations

import json

from datetime import datetime
from pathlib import Path
from typing import Any

from .add_entry_fields import experience_retired, experience_status
from .add_layout import load_topics
from .index import Topic, Vector, replace_snapshot, set_embedding


REGISTRY_TABLES = """
CREATE SCHEMA IF NOT EXISTS memos_project;
CREATE TABLE IF NOT EXISTS memos_project.pm_spaces (
    tenant_id text NOT NULL,
    space_id text PRIMARY KEY,
    cleared_at timestamptz,
    deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS memos_project.pm_domains (
    space_id text NOT NULL,
    domain text NOT NULL,
    PRIMARY KEY (space_id, domain)
);
"""


def install(cursor: Any) -> None:
    """Create the registry and, once, the retrieval tables of `schema.sql`."""
    cursor.execute("SELECT to_regclass('memos_project.pm_domains') AS present")
    if cursor.fetchone()["present"] is None:
        cursor.execute(REGISTRY_TABLES)
    cursor.execute("SELECT to_regclass('memos_project.pm_retrieval_roots') AS present")
    if cursor.fetchone()["present"] is None:
        cursor.execute(Path(__file__).with_name("schema.sql").read_text())


def sync_space(cursor: Any, tenant: str, space_id: str) -> None:
    """Mirror one Space and its Domains from the Add tables on the caller's search path."""
    cursor.execute(
        "SELECT cleared_at FROM spaces WHERE project_id = %s AND id = %s", (tenant, space_id)
    )
    row = cursor.fetchone()
    if row is None:
        cursor.execute(
            """UPDATE memos_project.pm_spaces SET deleted_at = COALESCE(deleted_at, clock_timestamp())
               WHERE tenant_id = %s AND space_id = %s""",
            (tenant, space_id),
        )
        cursor.execute("DELETE FROM memos_project.pm_domains WHERE space_id = %s", (space_id,))
        return
    cursor.execute(
        """INSERT INTO memos_project.pm_spaces (tenant_id, space_id, cleared_at, deleted_at)
           VALUES (%s, %s, %s, NULL)
           ON CONFLICT (space_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id,
               cleared_at = EXCLUDED.cleared_at, deleted_at = NULL""",
        (tenant, space_id, row["cleared_at"]),
    )
    cursor.execute("DELETE FROM memos_project.pm_domains WHERE space_id = %s", (space_id,))
    cursor.execute(
        """INSERT INTO memos_project.pm_domains (space_id, domain)
           SELECT space_id, domain FROM domains WHERE space_id = %s""",
        (space_id,),
    )


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value or "")


def _statement(item: dict, *keys: str) -> dict:
    data = {
        "content": item.get("content") or "",
        "time": _iso(item.get("time")),
        "user_ids": list(item.get("user_ids") or []),
    }
    data.update({key: item[key] for key in keys if item.get(key) is not None})
    return data


def topic_snapshot(row: dict) -> Topic:
    """The public Topic view of one committed `topics` row joined with its domain name."""
    from .add_index import topic_item_content

    decisions = [
        {
            "id": item["id"],
            **_statement(item, "source"),
            "user_labels": item.get("user_labels") or {},
            "history": [
                _statement(h, "reason", "source", "change_source")
                for h in item.get("history") or []
            ],
            "conflicts": [_statement(c, "source") for c in item.get("conflicts") or []],
        }
        for item in row["decisions"] or []
        if not item.get("archived")
    ]
    experiences = []
    for item in row["experiences"] or []:
        if experience_retired(item):
            continue
        card = item.get("card") or {}
        experiences.append(
            {
                "id": item["id"],
                "content": topic_item_content("experience", item) or item.get("content") or "",
                "time": _iso(item.get("time")),
                "user_ids": list(item.get("user_ids") or []),
                "task_intent": card.get("task_intent"),
                "exp_status": experience_status(item),
                "confidence": item.get("confidence"),
                "card": card,
                "version": item.get("version"),
                "sources": item.get("sources") or [],
            }
        )
    timeline = [
        {"id": item["id"], **_statement(item)}
        for item in row["timeline"] or []
        if item.get("id") and not item.get("archived")
    ]
    return Topic.model_validate(
        {
            "id": row["id"],
            "domain": row["domain"],
            "topic_name": row["topic_name"],
            "topic_summary": row["topic_summary"] or "",
            "topic_description": row["topic_description"] or "",
            "create_time": _iso(row["create_time"]),
            "update_time": _iso(row["update_time"]),
            "sources": row["sources"] or [],
            "decisions": decisions,
            "experiences": experiences,
            "timeline": timeline,
        }
    )


def _vector(text: str | None, model: str | None) -> Vector | None:
    if not text or not model:
        return None
    return Vector(model=model, values=json.loads(text))


def publish_topics(
    cursor: Any, tenant: str, space_id: str, topic_ids: list[str], accepted_at: datetime
) -> int:
    """Replace the index snapshot of each Topic at its committed version, with stored vectors."""
    if not topic_ids:
        return 0
    rows = load_topics(
        cursor, "t.space_id = %s AND t.id = ANY(%s::text[])", (space_id, list(topic_ids))
    )
    published = 0
    for row in rows:
        if not replace_snapshot(
            cursor, tenant, space_id, row["id"], row["version"], accepted_at, topic_snapshot(row)
        ):
            continue
        published += 1
        model = row.get("embedding_model_id")
        vectors = []
        if vector := _vector(row.get("embedding"), model):
            vectors.append((row["id"], vector))
        cursor.execute(
            """SELECT id, embedding::text AS embedding_text FROM project_entries
               WHERE space_id = %s AND topic_id = %s AND embedding IS NOT NULL""",
            (space_id, row["id"]),
        )
        for item in cursor.fetchall():
            if vector := _vector(item["embedding_text"], model):
                vectors.append((item["id"], vector))
        for memory_id, vector in vectors:
            set_embedding(cursor, tenant, space_id, row["id"], row["version"], memory_id, 0, vector)
    return published


def retract_topics(
    cursor: Any, tenant: str, space_id: str, topic_ids: list[str], accepted_at: datetime
) -> None:
    """Remove deleted Topics; the higher revision keeps a delayed publish from reviving them."""
    for topic_id in topic_ids:
        cursor.execute(
            """SELECT revision FROM memos_project.pm_retrieval_roots
               WHERE tenant_id = %s AND space_id = %s AND root_id = %s""",
            (tenant, space_id, topic_id),
        )
        row = cursor.fetchone()
        if row is not None:
            replace_snapshot(
                cursor, tenant, space_id, topic_id, row["revision"] + 1, accepted_at, None
            )
