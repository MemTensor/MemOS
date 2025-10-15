"""
Pipeline test script for MemOS Server API functions.
This script directly tests add and search functionalities without going through the API layer.
If you want to start server_api set .env to MemOS/.env and run:
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8002 --workers 4
"""

from typing import Any

from dotenv import load_dotenv

# Import directly from server_router to reuse initialized components
from memos.api.routers.server_router import (
    _create_naive_mem_cube,
    mem_reader,
)
from memos.log import get_logger


# Load environment variables
load_dotenv()

logger = get_logger(__name__)


def test_add_memories(
    messages: list[dict[str, str]],
    user_id: str,
    mem_cube_id: str,
    session_id: str = "default_session",
) -> list[str]:
    """
    Test adding memories to the system.

    Args:
        messages: List of message dictionaries with 'role' and 'content'
        user_id: User identifier
        mem_cube_id: Memory cube identifier
        session_id: Session identifier

    Returns:
        List of memory IDs that were added
    """
    logger.info(f"Testing add memories for user: {user_id}, mem_cube: {mem_cube_id}")

    # Create NaiveMemCube using server_router function
    naive_mem_cube = _create_naive_mem_cube()

    # Extract memories from messages using server_router's mem_reader
    memories = mem_reader.get_memory(
        [messages],
        type="chat",
        info={
            "user_id": user_id,
            "session_id": session_id,
        },
    )

    # Flatten memory list
    flattened_memories = [mm for m in memories for mm in m]

    # Add memories to the system
    mem_id_list: list[str] = naive_mem_cube.text_mem.add(
        flattened_memories,
        user_name=mem_cube_id,
    )

    logger.info(f"Added {len(mem_id_list)} memories: {mem_id_list}")

    # Print details of added memories
    for memory_id, memory in zip(mem_id_list, flattened_memories, strict=False):
        logger.info(f"  - ID: {memory_id}")
        logger.info(f"    Memory: {memory.memory}")
        logger.info(f"    Type: {memory.metadata.memory_type}")

    return mem_id_list


def test_search_memories(
    query: str,
    user_id: str,
    mem_cube_id: str,
    session_id: str = "default_session",
    top_k: int = 5,
    mode: str = "fast",
    internet_search: bool = False,
    moscube: bool = False,
    chat_history: list | None = None,
) -> list[Any]:
    """
    Test searching memories from the system.

    Args:
        query: Search query text
        user_id: User identifier
        mem_cube_id: Memory cube identifier
        session_id: Session identifier
        top_k: Number of top results to return
        mode: Search mode
        internet_search: Whether to enable internet search
        moscube: Whether to enable moscube search
        chat_history: Chat history for context

    Returns:
        List of search results
    """

    # Create NaiveMemCube using server_router function
    naive_mem_cube = _create_naive_mem_cube()

    # Prepare search filter
    search_filter = {"session_id": session_id} if session_id != "default_session" else None

    search_results = naive_mem_cube.text_mem.search(
        query=query,
        user_name=mem_cube_id,
        top_k=top_k,
        mode=mode,
        manual_close_internet=not internet_search,
        moscube=moscube,
        search_filter=search_filter,
        info={
            "user_id": user_id,
            "session_id": session_id,
            "chat_history": chat_history or [],
        },
    )

    # Print search results
    for idx, result in enumerate(search_results, 1):
        logger.info(f"\n  Result {idx}:")
        logger.info(f"    ID: {result.id}")
        logger.info(f"    Memory: {result.memory}")
        logger.info(f"    Score: {getattr(result, 'score', 'N/A')}")
        logger.info(f"    Type: {result.metadata.memory_type}")

    return search_results


def main():
    # Test parameters
    user_id = "test_user_123"
    mem_cube_id = "test_cube_123"
    session_id = "test_session_001"

    test_messages = [
        {"role": "user", "content": "Where should I go for Christmas?"},
        {
            "role": "assistant",
            "content": "There are many places to visit during Christmas, such as the Bund and Disneyland in Shanghai.",
        },
        {"role": "user", "content": "What about New Year's Eve?"},
        {
            "role": "assistant",
            "content": "For New Year's Eve, you could visit Times Square in New York or watch fireworks at the Sydney Opera House.",
        },
    ]

    memory_ids = test_add_memories(
        messages=test_messages, user_id=user_id, mem_cube_id=mem_cube_id, session_id=session_id
    )

    logger.info(f"\nSuccessfully added {len(memory_ids)} memories!")

    search_queries = [
        "How to enjoy Christmas?",
        "Where to celebrate New Year?",
        "What are good places to visit during holidays?",
    ]

    for query in search_queries:
        logger.info("\n" + "-" * 80)
        results = test_search_memories(query=query, user_id=user_id, mem_cube_id=mem_cube_id)
        print(f"Query: '{query}' returned {len(results)} results")


if __name__ == "__main__":
    main()
