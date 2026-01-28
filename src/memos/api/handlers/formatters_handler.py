"""
Data formatting utilities for server handlers.

This module provides utility functions for formatting and transforming data
structures for API responses, including memory items and preferences.
"""

from typing import Any

from memos.log import get_logger
from memos.templates.instruction_completion import instruct_completion


logger = get_logger(__name__)


def to_iter(running: Any) -> list[Any]:
    """
    Normalize running tasks to a list of task objects.

    Handles different input types and converts them to a consistent list format.

    Args:
        running: Running tasks, can be None, dict, or iterable

    Returns:
        List of task objects
    """
    if running is None:
        return []
    if isinstance(running, dict):
        return list(running.values())
    return list(running) if running else []


def format_memory_item(
    memory_data: Any, include_embedding: bool = False, save_sources: bool = True
) -> dict[str, Any]:
    """
    Format a single memory item for API response.

    Transforms a memory object into a dictionary with metadata properly
    structured for API consumption.

    Args:
        memory_data: Memory object to format

    Returns:
        Formatted memory dictionary with ref_id and metadata
    """
    memory = memory_data.model_dump()
    memory_id = memory["id"]
    ref_id = f"[{memory_id.split('-')[0]}]"

    memory["ref_id"] = ref_id
    if not include_embedding:
        memory["metadata"]["embedding"] = []
    if not save_sources:
        memory["metadata"]["sources"] = []
    memory["metadata"]["usage"] = []
    memory["metadata"]["ref_id"] = ref_id
    memory["metadata"]["id"] = memory_id
    memory["metadata"]["memory"] = memory["memory"]

    return memory


def post_process_pref_mem(
    memories_result: dict[str, Any],
    pref_formatted_mem: list[dict[str, Any]],
    mem_cube_id: str,
    include_preference: bool,
) -> dict[str, Any]:
    """
    Post-process preference memory results.

    Adds formatted preference memories to the result dictionary and generates
    instruction completion strings if preferences are included.

    Args:
        memories_result: Result dictionary to update
        pref_formatted_mem: List of formatted preference memories
        mem_cube_id: Memory cube ID
        include_preference: Whether to include preferences in result

    Returns:
        Updated memories_result dictionary
    """
    if include_preference:
        memories_result["pref_mem"].append(
            {
                "cube_id": mem_cube_id,
                "memories": pref_formatted_mem,
                "total_nodes": len(pref_formatted_mem),
            }
        )
        pref_instruction, pref_note = instruct_completion(pref_formatted_mem)
        memories_result["pref_string"] = pref_instruction
        memories_result["pref_note"] = pref_note

    return memories_result


def post_process_textual_mem(
    memories_result: dict[str, Any],
    text_formatted_mem: list[dict[str, Any]],
    mem_cube_id: str,
) -> dict[str, Any]:
    """
    Post-process text and tool memory results.
    """
    fact_mem = [
        mem
        for mem in text_formatted_mem
        if mem["metadata"]["memory_type"]
        in ["WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"]
    ]
    tool_mem = [
        mem
        for mem in text_formatted_mem
        if mem["metadata"]["memory_type"] in ["ToolSchemaMemory", "ToolTrajectoryMemory"]
    ]
    skill_mem = [
        mem for mem in text_formatted_mem if mem["metadata"]["memory_type"] == "SkillMemory"
    ]

    memories_result["text_mem"].append(
        {
            "cube_id": mem_cube_id,
            "memories": fact_mem,
            "total_nodes": len(fact_mem),
        }
    )
    memories_result["tool_mem"].append(
        {
            "cube_id": mem_cube_id,
            "memories": tool_mem,
            "total_nodes": len(tool_mem),
        }
    )
    memories_result["skill_mem"].append(
        {
            "cube_id": mem_cube_id,
            "memories": skill_mem,
            "total_nodes": len(skill_mem),
        }
    )
    return memories_result


def separate_knowledge_and_conversation_mem(memories: list[dict[str, Any]]):
    """
    Separate knowledge and conversation memories from retrieval results.
    """
    knowledge_mem = []
    conversation_mem = []
    for item in memories:
        sources = item.get("metadata", {}).get("sources", [])
        if (
            len(sources) > 0
            and "type" in sources[0]
            and sources[0]["type"] == "file"
            and "content" in sources[0]
            and sources[0]["content"] != ""
        ):  # TODO change to memory_type
            knowledge_mem.append(item)
        else:
            conversation_mem.append(item)

    logger.info(
        f"Retrieval results number of knowledge_mem: {len(knowledge_mem)}, conversation_mem: {len(conversation_mem)}"
    )
    return knowledge_mem, conversation_mem


def rerank_knowledge_mem(
    reranker: Any,
    query: str,
    text_mem: list[dict[str, Any]],
    top_k: int,
    file_mem_proportion: float = 0.5,
) -> list[dict[str, Any]]:
    """
    Rerank knowledge memories and keep conversation memories.
    """
    memid2cubeid = {}
    memories_list = []
    for memory_group in text_mem:
        cube_id = memory_group["cube_id"]
        memories = memory_group["memories"]
        memories_list.extend(memories)
        for memory in memories:
            memid2cubeid[memory["id"]] = cube_id

    knowledge_mem, conversation_mem = separate_knowledge_and_conversation_mem(memories_list)
    knowledge_mem_top_k = max(int(top_k * file_mem_proportion), int(top_k - len(conversation_mem)))
    # rerank set unuse
    reranked_knowledge_mem = knowledge_mem

    # Sort by relativity in descending order
    reranked_knowledge_mem = sorted(
        reranked_knowledge_mem,
        key=lambda item: item.get("metadata", {}).get("relativity", 0.0),
        reverse=True,
    )

    # TODO revoke sources replace memory value
    for item in reranked_knowledge_mem:
        item["memory"] = item["metadata"]["sources"][0]["content"]
        item["metadata"]["sources"] = []

    for item in conversation_mem:
        item.setdefault("metadata", {})["sources"] = []

    # deduplicate: remove items with duplicate memory content
    original_count = len(reranked_knowledge_mem)
    seen_memories = set[Any]()
    deduplicated_knowledge_mem = []
    for item in reranked_knowledge_mem:
        memory_content = item.get("memory", "")
        if memory_content and memory_content not in seen_memories:
            seen_memories.add(memory_content)
            deduplicated_knowledge_mem.append(item)
    deduplicated_count = len(deduplicated_knowledge_mem)
    logger.info(
        f"After filtering duplicate knowledge base text from sources, count changed from {original_count} to {deduplicated_count}"
    )

    reranked_knowledge_mem = deduplicated_knowledge_mem[:knowledge_mem_top_k]
    conversation_mem_top_k = top_k - len(reranked_knowledge_mem)
    cubeid2memories = {}
    text_mem_res = []

    for memory in reranked_knowledge_mem + conversation_mem[:conversation_mem_top_k]:
        cube_id = memid2cubeid[memory["id"]]
        if cube_id not in cubeid2memories:
            cubeid2memories[cube_id] = []
        cubeid2memories[cube_id].append(memory)

    for cube_id, memories in cubeid2memories.items():
        text_mem_res.append(
            {
                "cube_id": cube_id,
                "memories": memories,
            }
        )

    return text_mem_res
