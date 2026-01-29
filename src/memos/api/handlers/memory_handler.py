"""
Memory handler for retrieving and managing memories.

This module handles retrieving all memories or specific subgraphs based on queries.
"""

from typing import TYPE_CHECKING, Any, Literal

from memos.api.handlers.formatters_handler import (
    format_memory_item,
    post_process_pref_mem,
    post_process_textual_mem,
)
from memos.api.product_models import (
    DeleteMemoryRequest,
    DeleteMemoryResponse,
    GetMemoryRequest,
    GetMemoryResponse,
    MemoryResponse,
)
from memos.log import get_logger
from memos.mem_cube.navie import NaiveMemCube
from memos.mem_os.utils.format_utils import (
    convert_graph_to_tree_forworkmem,
    ensure_unique_tree_ids,
    filter_nodes_by_tree_ids,
    remove_embedding_recursive,
    sort_children_by_memory_type,
)


if TYPE_CHECKING:
    from memos.memories.textual.preference import TextualMemoryItem


logger = get_logger(__name__)


def handle_get_all_memories(
    user_id: str,
    mem_cube_id: str,
    memory_type: Literal["text_mem", "act_mem", "param_mem", "para_mem"],
    naive_mem_cube: Any,
) -> MemoryResponse:
    """
    Main handler for getting all memories.

    Retrieves all memories of specified type for a user and formats them appropriately.

    Args:
        user_id: User ID
        mem_cube_id: Memory cube ID
        memory_type: Type of memory to retrieve
        naive_mem_cube: Memory cube instance

    Returns:
        MemoryResponse with formatted memory data
    """
    try:
        reformat_memory_list = []

        if memory_type == "text_mem":
            # Get all text memories from the graph database
            memories = naive_mem_cube.text_mem.get_all(user_name=mem_cube_id)

            # Format and convert to tree structure
            memories_cleaned = remove_embedding_recursive(memories)
            custom_type_ratios = {
                "WorkingMemory": 0.20,
                "LongTermMemory": 0.40,
                "UserMemory": 0.40,
            }
            tree_result, node_type_count = convert_graph_to_tree_forworkmem(
                memories_cleaned, target_node_count=200, type_ratios=custom_type_ratios
            )
            # Ensure all node IDs are unique in the tree structure
            tree_result = ensure_unique_tree_ids(tree_result)
            memories_filtered = filter_nodes_by_tree_ids(tree_result, memories_cleaned)
            children = tree_result["children"]
            children_sort = sort_children_by_memory_type(children)
            tree_result["children"] = children_sort
            memories_filtered["tree_structure"] = tree_result

            reformat_memory_list.append(
                {
                    "cube_id": mem_cube_id,
                    "memories": [memories_filtered],
                    "memory_statistics": node_type_count,
                }
            )

        elif memory_type == "act_mem":
            logger.warning("Activity memory retrieval not implemented yet.")
        elif memory_type == "para_mem":
            logger.warning("Parameter memory retrieval not implemented yet.")
        return MemoryResponse(
            message="Memories retrieved successfully",
            data=reformat_memory_list,
        )

    except Exception as e:
        logger.error(f"Failed to get all memories: {e}", exc_info=True)
        raise


def handle_get_subgraph(
    user_id: str,
    mem_cube_id: str,
    query: str,
    top_k: int,
    naive_mem_cube: Any,
) -> MemoryResponse:
    """
    Main handler for getting memory subgraph based on query.

    Retrieves relevant memory subgraph and formats it as a tree structure.

    Args:
        user_id: User ID
        mem_cube_id: Memory cube ID
        query: Search query
        top_k: Number of top results to return
        naive_mem_cube: Memory cube instance

    Returns:
        MemoryResponse with formatted subgraph data
    """
    try:
        # Get relevant subgraph from text memory
        memories = naive_mem_cube.text_mem.get_relevant_subgraph(
            query, top_k=top_k, user_name=mem_cube_id
        )

        # Format and convert to tree structure
        memories_cleaned = remove_embedding_recursive(memories)
        custom_type_ratios = {
            "WorkingMemory": 0.20,
            "LongTermMemory": 0.40,
            "UserMemory": 0.40,
        }
        tree_result, node_type_count = convert_graph_to_tree_forworkmem(
            memories_cleaned, target_node_count=150, type_ratios=custom_type_ratios
        )
        # Ensure all node IDs are unique in the tree structure
        tree_result = ensure_unique_tree_ids(tree_result)
        memories_filtered = filter_nodes_by_tree_ids(tree_result, memories_cleaned)
        children = tree_result["children"]
        children_sort = sort_children_by_memory_type(children)
        tree_result["children"] = children_sort
        memories_filtered["tree_structure"] = tree_result

        reformat_memory_list = [
            {
                "cube_id": mem_cube_id,
                "memories": [memories_filtered],
                "memory_statistics": node_type_count,
            }
        ]

        return MemoryResponse(
            message="Memories retrieved successfully",
            data=reformat_memory_list,
        )

    except Exception as e:
        logger.error(f"Failed to get subgraph: {e}", exc_info=True)
        raise


def handle_get_memory(memory_id: str, naive_mem_cube: NaiveMemCube) -> GetMemoryResponse:
    """
    Handler for getting a single memory by its ID.

    Tries to retrieve from text memory first, then preference memory if not found.

    Args:
        memory_id: The ID of the memory to retrieve
        naive_mem_cube: Memory cube instance

    Returns:
        GetMemoryResponse with the memory data
    """

    try:
        memory = naive_mem_cube.text_mem.get(memory_id)
    except Exception:
        memory = None

    # If not found in text memory, try preference memory
    pref = None
    if memory is None and naive_mem_cube.pref_mem is not None:
        collection_names = ["explicit_preference", "implicit_preference"]
        for collection_name in collection_names:
            try:
                pref = naive_mem_cube.pref_mem.get_with_collection_name(collection_name, memory_id)
                if pref is not None:
                    break
            except Exception:
                continue

    # Get the data from whichever memory source succeeded
    data = (memory or pref).model_dump() if (memory or pref) else None

    return GetMemoryResponse(
        message="Memory retrieved successfully"
        if data
        else f"Memory with ID {memory_id} not found",
        code=200,
        data=data,
    )


def handle_get_memory_by_ids(
    memory_ids: list[str], naive_mem_cube: NaiveMemCube
) -> GetMemoryResponse:
    """
    Handler for getting multiple memories by their IDs.

    Retrieves multiple memories and formats them as a list of dictionaries.
    """
    try:
        memories = naive_mem_cube.text_mem.get_by_ids(memory_ids=memory_ids)
    except Exception:
        memories = []

    # Ensure memories is not None
    if memories is None:
        memories = []

    if naive_mem_cube.pref_mem is not None:
        collection_names = ["explicit_preference", "implicit_preference"]
        for collection_name in collection_names:
            try:
                result = naive_mem_cube.pref_mem.get_by_ids_with_collection_name(
                    collection_name, memory_ids
                )
                if result is not None:
                    result = [format_memory_item(item, save_sources=False) for item in result]
                    memories.extend(result)
            except Exception:
                continue

    return GetMemoryResponse(
        message="Memories retrieved successfully", code=200, data={"memories": memories}
    )


def handle_get_memories(
    get_mem_req: GetMemoryRequest, naive_mem_cube: NaiveMemCube
) -> GetMemoryResponse:
    results: dict[str, Any] = {"text_mem": [], "pref_mem": [], "tool_mem": [], "skill_mem": []}
    memories = naive_mem_cube.text_mem.get_all(
        user_name=get_mem_req.mem_cube_id,
        user_id=get_mem_req.user_id,
        page=get_mem_req.page,
        page_size=get_mem_req.page_size,
        filter=get_mem_req.filter,
    )["nodes"]

    results = post_process_textual_mem(results, memories, get_mem_req.mem_cube_id)

    if not get_mem_req.include_tool_memory:
        results["tool_mem"] = []
    if not get_mem_req.include_skill_memory:
        results["skill_mem"] = []

    preferences: list[TextualMemoryItem] = []

    format_preferences = []
    if get_mem_req.include_preference and naive_mem_cube.pref_mem is not None:
        filter_params: dict[str, Any] = {}
        if get_mem_req.user_id is not None:
            filter_params["user_id"] = get_mem_req.user_id
        if get_mem_req.mem_cube_id is not None:
            filter_params["mem_cube_id"] = get_mem_req.mem_cube_id
        if get_mem_req.filter is not None:
            # Check and remove user_id/mem_cube_id from filter if present
            filter_copy = get_mem_req.filter.copy()
            removed_fields = []

            if "user_id" in filter_copy:
                filter_copy.pop("user_id")
                removed_fields.append("user_id")
            if "mem_cube_id" in filter_copy:
                filter_copy.pop("mem_cube_id")
                removed_fields.append("mem_cube_id")

            if removed_fields:
                logger.warning(
                    f"Fields {removed_fields} found in filter will be ignored. "
                    f"Use request-level user_id/mem_cube_id parameters instead."
                )

            filter_params.update(filter_copy)

        preferences, _ = naive_mem_cube.pref_mem.get_memory_by_filter(
            filter_params, page=get_mem_req.page, page_size=get_mem_req.page_size
        )
        format_preferences = [format_memory_item(item, save_sources=False) for item in preferences]

    results = post_process_pref_mem(
        results, format_preferences, get_mem_req.mem_cube_id, get_mem_req.include_preference
    )

    # Filter to only keep text_mem, pref_mem, tool_mem
    filtered_results = {
        "text_mem": results.get("text_mem", []),
        "pref_mem": results.get("pref_mem", []),
        "tool_mem": results.get("tool_mem", []),
        "skill_mem": results.get("skill_mem", []),
    }

    return GetMemoryResponse(message="Memories retrieved successfully", data=filtered_results)


def handle_delete_memories(delete_mem_req: DeleteMemoryRequest, naive_mem_cube: NaiveMemCube):
    logger.info(
        f"[Delete memory request] writable_cube_ids: {delete_mem_req.writable_cube_ids}, memory_ids: {delete_mem_req.memory_ids}"
    )
    # Validate that only one of memory_ids, file_ids, or filter is provided
    provided_params = [
        delete_mem_req.memory_ids is not None,
        delete_mem_req.file_ids is not None,
        delete_mem_req.filter is not None,
    ]
    if sum(provided_params) != 1:
        return DeleteMemoryResponse(
            message="Exactly one of memory_ids, file_ids, or filter must be provided",
            data={"status": "failure"},
        )

    try:
        if delete_mem_req.memory_ids is not None:
            naive_mem_cube.text_mem.delete_by_memory_ids(delete_mem_req.memory_ids)
            if naive_mem_cube.pref_mem is not None:
                naive_mem_cube.pref_mem.delete(delete_mem_req.memory_ids)
        elif delete_mem_req.file_ids is not None:
            naive_mem_cube.text_mem.delete_by_filter(
                writable_cube_ids=delete_mem_req.writable_cube_ids, file_ids=delete_mem_req.file_ids
            )
        elif delete_mem_req.filter is not None:
            naive_mem_cube.text_mem.delete_by_filter(filter=delete_mem_req.filter)
            if naive_mem_cube.pref_mem is not None:
                naive_mem_cube.pref_mem.delete_by_filter(filter=delete_mem_req.filter)
    except Exception as e:
        logger.error(f"Failed to delete memories: {e}", exc_info=True)
        return DeleteMemoryResponse(
            message="Failed to delete memories",
            data={"status": "failure"},
        )
    return DeleteMemoryResponse(
        message="Memories deleted successfully",
        data={"status": "success"},
    )
