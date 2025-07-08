"""
Example demonstrating how to use MOSProduct for multi-user scenarios.
"""

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.product import MOSProduct


def get_config(user_name):
    openapi_config = {
        "model_name_or_path": "gpt-4o-mini",
        "temperature": 0.8,
        "max_tokens": 1024,
        "top_p": 0.9,
        "top_k": 50,
        "remove_think_prefix": True,
        "api_key": "your-api-key-here",
        "api_base": "https://api.openai.com/v1",
    }
    # Create a default configuration
    default_config = MOSConfig(
        user_id="root",
        chat_model={"backend": "openai", "config": openapi_config},
        mem_reader={
            "backend": "naive",
            "config": {
                "llm": {
                    "backend": "openai",
                    "config": openapi_config,
                },
                "embedder": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "nomic-embed-text:latest",
                    },
                },
            },
        },
        enable_textual_memory=True,
        enable_activation_memory=False,
        top_k=5,
        max_turns_window=20,
    )
    default_cube_config = GeneralMemCubeConfig.model_validate(
        {
            "user_id": user_name,
            "cube_id": f"{user_name}_default_cube",
            "text_mem": {
                "backend": "tree_text",
                "config": {
                    "extractor_llm": {"backend": "openai", "config": openapi_config},
                    "dispatcher_llm": {"backend": "openai", "config": openapi_config},
                    "graph_db": {
                        "backend": "neo4j",
                        "config": {
                            "uri": "bolt://localhost:7687",
                            "user": "neo4j",
                            "password": "12345678",
                            "db_name": user_name,
                            "auto_create": True,
                        },
                    },
                    "embedder": {
                        "backend": "ollama",
                        "config": {
                            "model_name_or_path": "nomic-embed-text:latest",
                        },
                    },
                },
            },
            "act_mem": {},
            "para_mem": {},
        }
    )
    default_mem_cube = GeneralMemCube(default_cube_config)
    return default_config, default_mem_cube


def main():
    default_config, default_mem_cube = get_config(user_name="alice")
    # Initialize MOSProduct with default config
    mos_product = MOSProduct(default_config=default_config)

    # Register first user with default config
    result1 = mos_product.user_register(
        user_id="alice",
        user_name="alice",
        interests="I'm interested in machine learning and AI research.",
        default_mem_cube=default_mem_cube,
    )
    print(f"User registration result: {result1}")

    # Chat with Alice
    print("\n=== Chatting with Alice ===")
    for response_chunk in mos_product.chat(query="What are my interests?", user_id="alice"):
        print(response_chunk, end="")

    # Add memory for Alice
    mos_product.add(
        user_id="alice",
        memory_content="I attended a machine learning conference last week.",
        mem_cube_id=result1["default_cube_id"],
    )

    # Search memories for Alice
    search_result = mos_product.search(query="conference", user_id="alice")
    print(f"\nSearch result for Alice: {search_result}")

    # Search memories for Alice
    search_result = mos_product.get_all(query="conference", user_id="alice", memory_type="text_mem")
    print(f"\nSearch result for Alice: {search_result}")

    # List all users
    users = mos_product.list_users()
    print(f"\nAll registered users: {users}")

    # Get user info
    alice_info = mos_product.get_user_info("alice")
    print(f"\nAlice's info: {alice_info}")


if __name__ == "__main__":
    main()
