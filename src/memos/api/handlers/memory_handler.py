"""
Memory handler for retrieving and managing memories.

This module handles retrieving all memories or specific subgraphs based on queries.
"""

from typing import Any, Literal

from memos.api.product_models import (
    DeleteMemoryRequest,
    DeleteMemoryResponse,
    GetMemoryRequest,
    GetMemoryResponse,
    MemoryResponse,
)
from memos.log import get_logger
from memos.mem_os.utils.format_utils import (
    convert_graph_to_tree_forworkmem,
    ensure_unique_tree_ids,
    filter_nodes_by_tree_ids,
    remove_embedding_recursive,
    sort_children_by_memory_type,
)


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


def handle_get_memories(self, get_mem_req: GetMemoryRequest):
    return GetMemoryResponse(
        message="Memories retrieved successfully",
        data=None,
    )


def handle_delete_memories(self, delete_mem_req: DeleteMemoryRequest):
    return DeleteMemoryResponse(
        message="Memories deleted successfully",
        data=None,
    )
