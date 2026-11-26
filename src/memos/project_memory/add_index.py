"""Scoped Topic recall and optional vector projection preparation."""

from __future__ import annotations

import math
import re

from collections import Counter
from copy import deepcopy
from typing import TYPE_CHECKING

from memos.log import get_logger

from .add_entry_fields import experience_retired
from .add_layout import child_key
from .add_limits import LIMITS, cut_at_sentence


if TYPE_CHECKING:
    from collections.abc import Callable

    from .add_store import PostgresAddStore


logger = get_logger(__name__)


def _vectors(embedder: Callable, texts: list[str], dimension: int) -> list[str]:
    vectors = embedder(texts)
    if len(vectors) != len(texts):
        raise ValueError("Embedding provider returned the wrong batch size")
    result = []
    for vector in vectors:
        values = list(map(float, vector))
        if len(values) != dimension or not all(map(math.isfinite, values)) or not any(values):
            raise ValueError("Embedding provider returned an invalid vector")
        result.append("[" + ",".join(map(str, values)) + "]")
    return result


def topic_item_content(kind: str, item: dict) -> str:
    """Derive the same text for projection and embedding."""
    if kind != "experience":
        return item.get("content") or ""
    card = item.get("card") or item.get("info") or {}
    text = "｜".join(
        str(card[key]) for key in ("task_intent", "problem", "principle") if card.get(key)
    )
    return cut_at_sentence(text, LIMITS.experience)[0]


def ranked_topics(
    store: PostgresAddStore,
    episode: dict,
    embedder: Callable[[list[str]], list[list[float]]] | None = None,
    *,
    limit: int = 20,
) -> tuple[list[tuple[float, dict]], bool]:
    """Rank scoped Topic overviews using PostgreSQL text and vector indexes."""
    summary = str(episode.get("episode_summary") or "")
    terms = list(dict.fromkeys(re.findall(r"\w+", summary)))[:20]
    if not terms:
        return [], embedder is None
    query = " OR ".join(terms)
    vector = None
    if embedder is not None:
        try:
            vector = _vectors(embedder, [summary], store.dim)[0]
        except Exception as exc:
            logger.warning("Project memory overview embedding unavailable (%s)", type(exc).__name__)
    scope = (episode["space_id"], episode.get("domains") or [])
    # The shared topics.search_tsv is generated with the schema's text search configuration.
    config = getattr(store, "text_search_config", "simple")
    with store.transaction(readonly=True) as cursor:
        cursor.execute(
            """SELECT t.id FROM topics t
                 JOIN domains d ON d.space_id = t.space_id AND d.id = t.domain_id
               WHERE t.space_id = %s AND d.domain = ANY(%s::text[])
                 AND t.search_tsv @@ websearch_to_tsquery(%s::regconfig, %s)
               ORDER BY ts_rank(t.search_tsv, websearch_to_tsquery(%s::regconfig, %s)) DESC, t.id
               LIMIT %s""",
            (*scope, config, query, config, query, limit),
        )
        lexical = cursor.fetchall()
        semantic = []
        if vector is not None:
            cursor.execute(
                """SELECT t.id FROM topics t
                     JOIN domains d ON d.space_id = t.space_id AND d.id = t.domain_id
                   WHERE t.space_id = %s AND d.domain = ANY(%s::text[])
                     AND t.embedding IS NOT NULL
                   ORDER BY t.embedding <=> %s::vector, t.id LIMIT %s""",
                (*scope, vector, limit),
            )
            semantic = cursor.fetchall()
    scores: Counter[str] = Counter()
    for ranking in (lexical, semantic):
        for index, row in enumerate(ranking, start=1):
            scores[row["id"]] += 1.0 / (60 + index)
    ids = sorted(scores, key=lambda tid: (-scores[tid], tid))[:limit]
    return [(scores[tid], {"id": tid}) for tid in ids], vector is None


def index_changeset(
    changeset: dict,
    embedder: Callable[[list[str]], list[list[float]]] | None,
    dimension: int,
    *,
    model_id: str | None = None,
) -> dict:
    """Prepare projection vectors outside the database transaction."""
    if embedder is None or not changeset["topics"]:
        return changeset
    out = deepcopy(changeset)
    texts: list[str] = []
    destinations: list[tuple[dict, str]] = []
    for edit in out["topics"]:
        topic = edit["topic"]
        edit.update(embedding_model_id=model_id, item_embeddings={})
        edit.pop("embedding", None)
        texts.append(
            "\n".join(topic[k] for k in ("topic_name", "topic_summary", "topic_description"))
        )
        destinations.append((edit, "embedding"))
        for kind, field in (
            ("decision", "decisions"),
            ("experience", "experiences"),
            ("timeline", "timeline"),
        ):
            for item in topic.get(field) or []:
                text = topic_item_content(kind, item)
                retired = item.get("archived") or (
                    kind == "experience" and experience_retired(item)
                )
                if text and not retired:
                    texts.append(text)
                    destinations.append((edit["item_embeddings"], item["id"]))
                if kind != "decision" or retired:
                    continue
                # Decision child rows are searchable too: new history rows and every conflict
                # (conflicts are rewritten whole) carry their own vector.
                children = [
                    (child_key(item["id"], "h", seq), row)
                    for seq, row in enumerate(item.get("history") or [], 1)
                    if not row.get("id")
                ] + [
                    (child_key(item["id"], "c", row.get("seq") or seq), row)
                    for seq, row in enumerate(item.get("conflicts") or [], 1)
                ]
                for key, row in children:
                    if row.get("content"):
                        texts.append(row["content"])
                        destinations.append((edit["item_embeddings"], key))
    try:
        vectors = _vectors(embedder, texts, dimension)
    except Exception as exc:
        logger.warning("Project memory projection embedding unavailable (%s)", type(exc).__name__)
        out["warnings"] = list(dict.fromkeys([*out["warnings"], "EMBEDDING_UNAVAILABLE"]))
        return out
    for (destination, key), vector in zip(destinations, vectors, strict=True):
        destination[key] = vector
    return out
