import uuid

from typing import Any

from memos.memories.textual.item import TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree import TextualMemoryItem


def format_textual_memory_item(memory_data: Any) -> dict[str, Any]:
    """Format a single memory item for API response."""
    memory = memory_data.model_dump()
    memory_id = memory["id"]
    ref_id = f"[{memory_id.split('-')[0]}]"

    memory["ref_id"] = ref_id
    memory["metadata"]["embedding"] = []
    memory["metadata"]["sources"] = []
    memory["metadata"]["ref_id"] = ref_id
    memory["metadata"]["id"] = memory_id
    memory["metadata"]["memory"] = memory["memory"]

    return memory


def make_textual_item(memory_data):
    return memory_data


def text_to_textual_memory_item(
    text: str,
    user_id: str | None = None,
    session_id: str | None = None,
    memory_type: str = "WorkingMemory",
    tags: list[str] | None = None,
    key: str | None = None,
    sources: list | None = None,
    background: str = "",
    confidence: float = 0.99,
    embedding: list[float] | None = None,
) -> TextualMemoryItem:
    """
    Convert text into a TextualMemoryItem object.

    Args:
        text: Memory content text
        user_id: User ID
        session_id: Session ID
        memory_type: Memory type, defaults to "WorkingMemory"
        tags: List of tags
        key: Memory key or title
        sources: List of sources
        background: Background information
        confidence: Confidence score (0-1)
        embedding: Vector embedding

    Returns:
        TextualMemoryItem: Wrapped memory item
    """
    return TextualMemoryItem(
        id=str(uuid.uuid4()),
        memory=text,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=user_id,
            session_id=session_id,
            memory_type=memory_type,
            status="activated",
            tags=tags or [],
            key=key,
            embedding=embedding or [],
            usage=[],
            sources=sources or [],
            background=background,
            confidence=confidence,
            type="fact",
        ),
    )
