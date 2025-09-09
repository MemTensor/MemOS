from typing import List, Dict, Any, Union, Tuple


def process_source(items: List[Tuple[Any, Union[str, Dict[str, Any], List[Any]]]] | None = None) -> str:
    """
    Args:
        items: List of tuples where each tuple contains (memory, source).
               source can be str, Dict, or List.
    Returns:
        str: Concatenated source.
    """
    concat_data = []
    for item in items:
        memory, source = item
        print(memory, source)
        if isinstance(source, str):
            concat_data.append(source)
    return "\n".join(concat_data)


def concat_original_source(
    graph_results: list,
    merge_field: List[str]=["sources"],
) -> list[str]:
    """
    Merge memory items with original dialogue.
    Args:
        graph_results (list[TextualMemoryItem]): List of memory items with embeddings.
        merge_field (List[str]): List of fields to merge.
    Returns:
        list[str]: List of memory and concat orginal memory.
    """
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