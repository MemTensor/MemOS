import re

from typing import Any

from memos.memories.textual.item import SourceMessage


_TAG1 = re.compile(r"^\s*\[[^\]]*\]\s*")


def get_encoded_tokens(content: str) -> int:
    """
    Get encoded tokens.
    Args:
        content: str
    Returns:
        int: Encoded tokens.
    """
    return len(content)


def truncate_data(data: list[str | dict[str, Any] | Any], max_tokens: int) -> list[str]:
    """
    Truncate data to max tokens.
    Args:
        data: List of strings or dictionaries.
        max_tokens: Maximum number of tokens.
    Returns:
        str: Truncated string.
    """
    truncated_string = ""
    for item in data:
        if isinstance(item, SourceMessage):
            content = getattr(item, "content", "")
            chat_time = getattr(item, "chat_time", "")
            if not content:
                continue
            truncated_string += f"[{chat_time}]: {content}\n"
            if get_encoded_tokens(truncated_string) > max_tokens:
                break
    return truncated_string


def process_source(
    items: list[tuple[Any, str | dict[str, Any] | list[Any]]] | None = None,
    recent_num: int = 10,
    max_tokens: int = 2048,
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
        concat_data.extend(source[-recent_num:])
    truncated_string = truncate_data(concat_data, max_tokens)
    if memory is not None:
        truncated_string = f"{memory}\n{truncated_string}"
    return truncated_string


def concat_original_source(
    graph_results: list,
    rerank_source: str | None = None,
) -> list[str]:
    """
    Merge memory items with original dialogue.
    Args:
        graph_results (list[TextualMemoryItem]): List of memory items with embeddings.
        merge_field (List[str]): List of fields to merge.
    Returns:
        list[str]: List of memory and concat orginal memory.
    """
    merge_field = []
    merge_field = ["sources"] if rerank_source is None else rerank_source.split(",")
    documents = []
    for item in graph_results:
        memory = _TAG1.sub("", m) if isinstance((m := getattr(item, "memory", None)), str) else m
        sources = []
        for field in merge_field:
            source = getattr(item.metadata, field, None)
            if source is None:
                continue
            sources.append((memory, source))
        concat_string = process_source(sources)
        documents.append(concat_string)
    return documents
