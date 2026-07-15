import os
import sys


# Add project root to python path to ensure src modules can be imported
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../src")))

from memos.configs.mem_chat import MemChatConfigFactory
from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.mem_chat.factory import MemChatFactory
from memos.mem_cube.general import GeneralMemCube


def get_mem_chat_config() -> MemChatConfigFactory:
    """
    Generates the configuration object for MemChat.

    MemChat is the top-level component for user interaction, responsible for managing the conversation flow,
    invoking the LLM, and interacting with the memory module.
    The configuration includes:
    - user_id: User identifier
    - chat_llm: LLM configuration used for chat (uses OpenAI compatible interface here)
    - max_turns_window: Size of the conversation history window
    - enable_textual_memory: Whether to enable textual memory (Explicit Memory)
    """
    return MemChatConfigFactory.model_validate(
        {
            "backend": "simple",
            "config": {
                "user_id": "user_123",
                "chat_llm": {
                    "backend": "openai",
                    "config": {
                        # Prioritize getting sensitive information and model configuration from environment variables
                        "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o"),
                        "temperature": 0.8,
                        "max_tokens": 1024,
                        "top_p": 0.9,
                        "top_k": 50,
                        "api_key": os.getenv("OPENAI_API_KEY"),
                        "api_base": os.getenv("OPENAI_API_BASE"),
                    },
                },
                "max_turns_window": 20,
                "top_k": 5,
                # Enable textual memory functionality, allowing the system to retrieve and store explicit memories
                "enable_textual_memory": True,
                # This example demonstrates only explicit memory, so activation memory and parametric memory are disabled
                "enable_activation_memory": False,
                "enable_parametric_memory": False,
            },
        }
    )


def get_mem_cube_config() -> GeneralMemCubeConfig:
    """
    Generates the configuration object for GeneralMemCube.

    MemCube (Memory Cube) is the core storage and management unit for memory.
    GeneralMemCube is a general implementation of the memory cube, supporting extraction, vectorized storage, and retrieval of textual memory.
    The configuration includes:
    - user_id / cube_id: Identifiers for the user and the cube to which the memory belongs
    - text_mem: Specific configuration for textual memory
        - extractor_llm: LLM used to extract memory fragments from the conversation
        - vector_db: Database used to store memory vectors (uses Qdrant here)
        - embedder: Model used to generate text vectors (uses OpenAI compatible interface here)
    """
    return GeneralMemCubeConfig.model_validate(
        {
            "user_id": "user03alice",
            "cube_id": "user03alice/mem_cube_tree",
            "text_mem": {
                "backend": "general_text",
                "config": {
                    "cube_id": "user03alice/mem_cube_general",
                    "memory_filename": "textual_memory.json",
                    "extractor_llm": {
                        "backend": "openai",
                        "config": {
                            "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o"),
                            "temperature": 0.8,
                            "max_tokens": 1024,
                            "top_p": 0.9,
                            "top_k": 50,
                            "api_key": os.getenv("OPENAI_API_KEY"),
                            "api_base": os.getenv("OPENAI_API_BASE"),
                        },
                    },
                    "vector_db": {
                        "backend": "qdrant",
                        "config": {
                            "collection_name": "user03alice_mem_cube_general",
                            "vector_dimension": 1024,
                            "distance_metric": "cosine",
                        },
                    },
                    "embedder": {
                        "backend": os.getenv("MOS_EMBEDDER_BACKEND", "universal_api"),
                        "config": {
                            "provider": "openai",
                            "api_key": os.getenv("MOS_EMBEDDER_API_KEY", "EMPTY"),
                            "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "bge-m3"),
                            "base_url": os.getenv("MOS_EMBEDDER_API_BASE"),
                        },
                    },
                },
            },
        }
    )


def main():
    """
    Main program entry point:
    1. Initialize MemChat (Conversation Controller)
    2. Initialize MemCube (Memory Storage)
    3. Mount MemCube to MemChat
    4. Start the chat loop
    5. Save memory after the chat ends
    """
    print("Initializing MemChat...")
    mem_chat_config = get_mem_chat_config()
    mem_chat = MemChatFactory.from_config(mem_chat_config)

    print("Initializing MemCube...")
    mem_cube_config = get_mem_cube_config()
    mem_cube = GeneralMemCube(mem_cube_config)

    # Mount the initialized memory cube onto the chat system
    # This allows MemChat to perform memory retrieval (search) and organization (organize) via mem_cube during the conversation
    mem_chat.mem_cube = mem_cube

    print("Starting Chat Session...")
    try:
        mem_chat.run()
    except KeyboardInterrupt:
        print("\nChat session interrupted.")
    finally:
        # Ensure memory is persisted to disk before the program exits
        # The dump method saves the in-memory memory state to the specified path
        print("Saving memory cube...")
        mem_chat.mem_cube.dump("new_cube_path")
        print("Memory cube saved to 'new_cube_path'.")


if __name__ == "__main__":
    main()
