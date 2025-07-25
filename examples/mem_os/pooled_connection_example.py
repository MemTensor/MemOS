"""
Example: Using Neo4j connection pooling to reduce connection overhead.

This example demonstrates how to use the neo4j-pooled backend to share
database connections across multiple users/memory instances.
"""

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.graph_dbs.connection_pool import connection_pool
from memos.mem_cube.general import GeneralMemCube


def create_user_cube(user_id: str, openai_api_key: str) -> GeneralMemCube:
    """Create a memory cube for a user using pooled connections."""

    config = GeneralMemCubeConfig(
        cube_id=f"user_{user_id}",
        text_mem={
            "backend": "tree_text",
            "config": {
                "extractor_llm": {
                    "backend": "openai",
                    "config": {
                        "api_key": openai_api_key,
                        "model_name": "gpt-4o-mini",
                    },
                },
                "dispatcher_llm": {
                    "backend": "openai",
                    "config": {
                        "api_key": openai_api_key,
                        "model_name": "gpt-4o-mini",
                    },
                },
                "graph_db": {
                    "backend": "neo4j-pooled",  # Use pooled version
                    "config": {
                        "uri": "bolt://localhost:7687",
                        "user": "neo4j",
                        "password": "12345678",
                        "db_name": "shared_memos",
                        "user_name": f"user_{user_id}",
                        "use_multi_db": False,
                        "auto_create": True,
                        "embedding_dimension": 3072,
                    },
                },
                "embedder": {
                    "backend": "sentence_transformer",
                    "config": {"model_name_or_path": "sentence-transformers/all-mpnet-base-v2"},
                },
                "reorganize": False,
            },
        },
    )

    return GeneralMemCube(config)


def main():
    """Demonstrate connection pooling with multiple users."""

    # Replace with your actual OpenAI API key
    openai_api_key = "your-openai-api-key-here"

    print("=== Neo4j Connection Pooling Demo ===")
    print(f"Initial connections: {connection_pool.get_active_connections()}")

    # Create multiple user cubes
    users = ["alice", "bob", "charlie"]
    cubes = {}

    for user_id in users:
        print(f"\nCreating cube for user: {user_id}")
        cubes[user_id] = create_user_cube(user_id, openai_api_key)
        print(f"Active connections: {connection_pool.get_active_connections()}")

    # Add some memories for each user
    memories = {
        "alice": "Alice loves hiking in the mountains.",
        "bob": "Bob is a software engineer who enjoys cooking.",
        "charlie": "Charlie plays guitar and loves jazz music.",
    }

    print("\n=== Adding memories ===")
    for user_id, memory in memories.items():
        if cubes[user_id].text_mem:
            cubes[user_id].text_mem.add(memory)
            print(f"Added memory for {user_id}")

    # Search memories
    print("\n=== Searching memories ===")
    for user_id in users:
        if cubes[user_id].text_mem:
            results = cubes[user_id].text_mem.search("hobbies", top_k=1)
            if results:
                print(f"{user_id}'s memory: {results[0].memory}")

    print(f"\nFinal active connections: {connection_pool.get_active_connections()}")
    print("Note: All users share the same database connection!")


if __name__ == "__main__":
    main()
