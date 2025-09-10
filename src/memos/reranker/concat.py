from typing import Any


def process_source(
    items: list[tuple[Any, str | dict[str, Any] | list[Any]]] | None = None, recent_num: int = 3
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
    for item in items:
        memory, source = item
        for content in source[:3]:
            if isinstance(content, str):
                concat_data.append(content)
    return "\n".join(concat_data)


def concat_original_source(
    graph_results: list,
    merge_field: list[str] | None = None,
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
        memory = getattr(item, "memory", "")
        sources = []
        for field in merge_field:
            source = getattr(item.metadata, field, "")
            sources.append((memory, source))
        concat_string = process_source(sources)
        documents.append(concat_string)
    return documents
