import re

from typing import Any, Literal
from .item import DialogueRankingTracker

_TAG1 = re.compile(r"^\s*\[[^\]]*\]\s*")


def concat_single_turn(
    graph_results: list,
) -> tuple[DialogueRankingTracker, dict[str, any]]:
    """
    Concatenate dialogue pairs into single strings for ranking.
    
    Args:
        graph_results: List of graph results
        
    Returns:
        List of concatenated dialogue pairs
        
    Example:
        >>> sources = ["user: hello", "assistant: hi there", "user: how are you?", "assistant: I'm good"]
        >>> concat_single_turn(messages)
        ["user: hello\nassistant: hi there", "user: how are you?\nassistant: I'm good"]
    """

    tracker = DialogueRankingTracker()
    original_items = {}
    
    def extract_content(msg: dict[str, Any] | str) -> str:
        """Extract content from message, handling both string and dict formats."""
        if isinstance(msg, dict):
            return msg.get('content', str(msg))
        return str(msg)

    for item in graph_results:
        memory = _TAG1.sub("", m) if isinstance((m := getattr(item, "memory", None)), str) else m
        sources = getattr(item.metadata, "sources", [])
        original_items[item.id] = item
    
        # Group messages into pairs and concatenate
        dialogue_pairs = []
        for i in range(0, len(sources), 2):
            user_msg = sources[i] if i < len(sources) else ""
            assistant_msg = sources[i + 1] if i + 1 < len(sources) else ""
            
            user_content = extract_content(user_msg)
            assistant_content = extract_content(assistant_msg)
            if user_content or assistant_content:  # Only add non-empty pairs
                pair_index = i // 2
                tracker.add_dialogue_pair(item.id, pair_index, user_msg, assistant_msg, memory)
    return tracker, original_items


def process_source(
    items: list[tuple[Any, str | dict[str, Any] | list[Any]]] | None = None, 
    concat_strategy: Literal["user", "assistant", "single_turn"] = "user",
) -> str:
    """
    Args:
        items: List of tuples where each tuple contains (memory, source).
               source can be str, Dict, or List.
        recent_num: Number of recent items to concatenate.
    Returns:
        str: Concatenated source.
    """
    if items is None:
        items = []
    concat_data = []
    memory = None
    for item in items:
        memory, source = item
        for content in source:
            if isinstance(content, str):
                if "assistant:" in content:
                    continue
                concat_data.append(content)
    if memory is not None:
        concat_data = [memory, *concat_data]
    return "\n".join(concat_data)


def concat_original_source(
    graph_results: list,
    merge_field: list[str] | None = None,
    concat_strategy: Literal["user", "assistant", "single_turn"] = "user",
) -> list[str]:
    """
    Merge memory items with original dialogue.
    Args:
        graph_results (list[TextualMemoryItem]): List of memory items with embeddings.
        merge_field (List[str]): List of fields to merge.
    Returns:
        list[str]: List of memory and concat orginal memory.
    """
    if merge_field is None:
        merge_field = ["sources"]
    documents = []
    for item in graph_results:
        memory = _TAG1.sub("", m) if isinstance((m := getattr(item, "memory", None)), str) else m
        sources = []
        for field in merge_field:
            source = getattr(item.metadata, field, "")
            sources.append((memory, source))
        concat_string = process_source(sources)
        documents.append(concat_string)
    return documents
