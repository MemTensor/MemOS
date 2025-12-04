"""
Data formatting utilities for server handlers.

This module provides utility functions for formatting and transforming data
structures for API responses, including memory items and preferences.
"""

from typing import Any

from memos.templates.instruction_completion import instruct_completion


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


def format_memory_item(memory_data: Any) -> dict[str, Any]:
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
    memory["metadata"]["embedding"] = []
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
        if mem["metadata"]["memory_type"] not in ["ToolSchemaMemory", "ToolTrajectoryMemory"]
    ]
    tool_mem = [
        mem
        for mem in text_formatted_mem
        if mem["metadata"]["memory_type"] in ["ToolSchemaMemory", "ToolTrajectoryMemory"]
    ]

    memories_result["text_mem"].append(
        {
            "cube_id": mem_cube_id,
            "memories": fact_mem,
        }
    )
    memories_result["tool_mem"].append(
        {
            "cube_id": mem_cube_id,
            "memories": tool_mem,
        }
    )
    return memories_result
