from __future__ import annotations

from memos.dream.enrichment import DreamHeuristicEnricher
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.types.general_types import UserContext


def _item(
    memory: str = "User is planning MemOS Dream v1.",
    *,
    role: str = "user",
    session_id: str = "session-a",
    project_id: str | None = "project-a",
    internal_info: dict | None = None,
    sources: list[SourceMessage] | None = None,
) -> TextualMemoryItem:
    return TextualMemoryItem(
        memory=memory,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="user-a",
            session_id=session_id,
            memory_type="LongTermMemory",
            project_id=project_id,
            sources=sources or [SourceMessage(type="chat", role=role, content=memory)],
            internal_info=internal_info,
        ),
    )


def test_heuristic_enricher_writes_dream_subdict_for_project_context():
    item = _item("Actually, the Dream v1 plan should use plugins. Can we do that?")
    enricher = DreamHeuristicEnricher(enabled=True, overwrite=False)

    enriched = enricher.enrich_items(
        items=[item],
        user_context=UserContext(session_id="session-a", project_id="project-a"),
        extract_mode="fine",
    )

    assert enriched == [item]
    dream = item.metadata.internal_info["dream"]
    assert dream["weak_context_id"] == "project:project-a"
    assert dream["signals"]["source_roles"] == ["user"]
    assert dream["signals"]["has_question"] is True
    assert dream["signals"]["has_correction"] is True
    assert dream["signals"]["is_chunk"] is False
    assert dream["salience"]["has_feedback"] is True
    assert dream["enriched_by"]["heuristic"] == "0.1.0"


def test_heuristic_enricher_falls_back_to_non_default_session():
    item = _item(project_id=None, session_id="session-b")
    enricher = DreamHeuristicEnricher(enabled=True, overwrite=False)

    enricher.enrich_items(items=[item], user_context=None, extract_mode="fine")

    assert item.metadata.internal_info["dream"]["weak_context_id"] == "session:session-b"


def test_heuristic_enricher_keeps_default_session_unbound_without_project():
    item = _item(project_id=None, session_id="default_session")
    enricher = DreamHeuristicEnricher(enabled=True, overwrite=False)

    enricher.enrich_items(items=[item], user_context=None, extract_mode="fine")

    assert item.metadata.internal_info["dream"]["weak_context_id"] is None


def test_heuristic_enricher_uses_batch_context_for_chunks():
    item_a = _item(
        "chunk one",
        internal_info={"ingest_batch_id": "ingest-1", "chunk_index": 0, "chunk_total": 2},
    )
    item_b = _item(
        "chunk two",
        internal_info={"ingest_batch_id": "ingest-1", "chunk_index": 1, "chunk_total": 2},
    )
    enricher = DreamHeuristicEnricher(enabled=True, overwrite=False)

    enricher.enrich_items(items=[item_a, item_b], user_context=None, extract_mode="fine")

    for item in (item_a, item_b):
        dream = item.metadata.internal_info["dream"]
        assert dream["batch_context_id"] == "batch:ingest-1"
        assert dream["weak_context_id"] == "batch:ingest-1"
        assert dream["signals"]["is_chunk"] is True
        assert dream["signals"]["chunk_total"] == 2


def test_heuristic_enricher_preserves_existing_semantic_fields_by_default():
    item = _item(
        internal_info={
            "dream": {
                "context_hint": "Existing semantic hint",
                "salience": {"unresolved": True, "has_feedback": False},
            }
        }
    )
    enricher = DreamHeuristicEnricher(enabled=True, overwrite=False)

    enricher.enrich_items(items=[item], user_context=None, extract_mode="fine")

    dream = item.metadata.internal_info["dream"]
    assert dream["context_hint"] == "Existing semantic hint"
    assert dream["salience"]["unresolved"] is True
    assert dream["salience"]["has_feedback"] is False


def test_heuristic_enricher_skips_when_disabled_or_not_fine():
    disabled_item = _item()
    disabled = DreamHeuristicEnricher(enabled=False)
    disabled.enrich_items(items=[disabled_item], user_context=None, extract_mode="fine")
    assert disabled_item.metadata.internal_info is None

    fast_item = _item()
    enabled = DreamHeuristicEnricher(enabled=True)
    enabled.enrich_items(items=[fast_item], user_context=None, extract_mode="fast")
    assert fast_item.metadata.internal_info is None
