import json
import os
import sys


# Add project root to python path to ensure src modules can be imported
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../src")))


def init_components():
    """
    Initialize MemOS core components.

    This function is responsible for building and configuring all basic components required for MemOS operation, including:
    1. LLM (Large Language Model): Model responsible for natural language understanding and generation (e.g., GPT-4o).
    2. Embedder: Responsible for converting text into vector representations for semantic search and similarity calculation.
    3. GraphDB (Neo4j): Graph database for persistent storage of memory nodes and their relationships.
    4. MemoryManager: Memory manager responsible for memory CRUD operations.
    5. MemReader: Memory reader for parsing and processing input text.
    6. Reranker: Reranker for refining the sorting of retrieval results.
    7. Searcher: Searcher that integrates retrieval and reranking logic.
    8. FeedbackServer (SimpleMemFeedback): Feedback service core, responsible for processing user feedback and updating memory.

    Returns:
        tuple: (feedback_server, memory_manager, embedder)
    """
    # Lazy import to avoid E402 (module level import not at top of file)
    from memos.configs.embedder import EmbedderConfigFactory
    from memos.configs.graph_db import GraphDBConfigFactory
    from memos.configs.llm import LLMConfigFactory
    from memos.configs.mem_reader import MemReaderConfigFactory
    from memos.configs.reranker import RerankerConfigFactory
    from memos.embedders.factory import EmbedderFactory
    from memos.graph_dbs.factory import GraphStoreFactory
    from memos.llms.factory import LLMFactory
    from memos.mem_feedback.simple_feedback import SimpleMemFeedback
    from memos.mem_reader.factory import MemReaderFactory
    from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
    from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
    from memos.reranker.factory import RerankerFactory

    print("Initializing MemOS Components...")

    # 1. LLM: Configure Large Language Model, using OpenAI compatible interface
    llm_config = LLMConfigFactory.model_validate(
        {
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
        }
    )
    llm = LLMFactory.from_config(llm_config)

    # 2. Embedder: Configure embedding model for generating text vectors
    embedder_config = EmbedderConfigFactory.model_validate(
        {
            "backend": os.getenv("MOS_EMBEDDER_BACKEND", "universal_api"),
            "config": {
                "provider": "openai",
                "api_key": os.getenv("MOS_EMBEDDER_API_KEY", "EMPTY"),
                "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "bge-m3"),
                "base_url": os.getenv("MOS_EMBEDDER_API_BASE"),
            },
        }
    )
    embedder = EmbedderFactory.from_config(embedder_config)

    # 3. GraphDB: Configure Neo4j graph database connection
    graph_db = GraphStoreFactory.from_config(
        GraphDBConfigFactory.model_validate(
            {
                "backend": "neo4j",
                "config": {
                    "uri": os.getenv("NEO4J_URI", "neo4j://127.0.0.1:7687"),
                    "user": os.getenv("NEO4J_USER", "neo4j"),
                    "password": os.getenv("NEO4J_PASSWORD", "12345678"),
                    "db_name": os.getenv("NEO4J_DB_NAME", "neo4j"),
                    "user_name": "zhs",
                    "auto_create": True,
                    "use_multi_db": False,
                    "embedding_dimension": int(os.getenv("EMBEDDING_DIMENSION", "1024")),
                },
            }
        )
    )

    # Clear test data for specific user to ensure a clean environment for each run
    graph_db.clear(user_name="cube_id_001_0115")

    # 4. MemoryManager: Core memory management, coordinating storage and retrieval
    memory_manager = MemoryManager(graph_db, embedder, llm, is_reorganize=False)

    # 5. MemReader: Configure memory reader, including chunking strategy
    mem_reader = MemReaderFactory.from_config(
        MemReaderConfigFactory.model_validate(
            {
                "backend": "simple_struct",
                "config": {
                    "llm": llm_config.model_dump(),
                    "embedder": embedder_config.model_dump(),
                    "chunker": {
                        "backend": "sentence",
                        "config": {
                            "tokenizer_or_token_counter": "gpt2",
                            "chunk_size": 512,
                            "chunk_overlap": 128,
                            "min_sentences_per_chunk": 1,
                        },
                    },
                },
            }
        )
    )

    # 6. Reranker: Configure reranker to improve retrieval relevance
    mem_reranker = RerankerFactory.from_config(
        RerankerConfigFactory.model_validate(
            {
                "backend": os.getenv("MOS_RERANKER_BACKEND", "cosine_local"),
                "config": {
                    "level_weights": {"topic": 1.0, "concept": 1.0, "fact": 1.0},
                    "level_field": "background",
                },
            }
        )
    )

    # 7. Searcher: Comprehensive searcher
    searcher = Searcher(llm, graph_db, embedder, mem_reranker)

    # 8. Feedback Server: Initialize feedback service, the core of this example
    feedback_server = SimpleMemFeedback(
        llm=llm,
        embedder=embedder,
        graph_store=graph_db,
        memory_manager=memory_manager,
        mem_reader=mem_reader,
        searcher=searcher,
        reranker=mem_reranker,
        pref_mem=None,
    )

    return feedback_server, memory_manager, embedder


def main():
    """
    Main program flow:
    1. Initialize components.
    2. Simulate a conversation scenario and existing (possibly incorrect) memory.
    3. Receive user feedback (correct memory).
    4. Process feedback and update memory store.
    5. Display processing results.
    """
    # Load dotenv in main to avoid affecting module import order
    from dotenv import load_dotenv

    load_dotenv()

    # Lazy import to avoid E402
    from memos.mem_feedback.utils import make_mem_item

    feedback_server, memory_manager, embedder = init_components()
    print("-" * 50)
    print("Initialization Done. Processing Feedback...")
    print("-" * 50)

    # 1. Simulate Chat History
    # Simulate a conversation between user and assistant, where the assistant's response contains a statement about user preferences.
    history = [
        {"role": "user", "content": "我喜欢什么水果,不喜欢什么水果"},
        {"role": "assistant", "content": "你喜欢苹果,不喜欢香蕉"},
    ]

    # 2. Simulate Initial Memory
    # We manually add a memory to the database, representing what the system currently believes to be a "fact".
    # This memory content is "你喜欢苹果,不喜欢香蕉", which we will later correct via feedback.
    mem_text = "你喜欢苹果,不喜欢香蕉"
    memory_manager.add(
        [
            make_mem_item(
                mem_text,
                user_id="user_id_001",
                user_name="cube_id_001_0115",
                session_id="session_id",
                tags=["fact"],
                key="food_preference",
                sources=[{"type": "chat"}],
                background="init from chat history",
                embedding=embedder.embed([mem_text])[
                    0
                ],  # Generate embedding for subsequent retrieval
                info={
                    "user_id": "user_id_001",
                    "user_name": "cube_id_001_0115",
                    "session_id": "session_id",
                },
            )
        ],
        user_name="cube_id_001_0115",
        mode="sync",
    )

    # 3. Feedback Input
    # The user points out the previous memory is incorrect and provides the correct information.
    feedback_content = "错了,实际上我喜欢的是山竹"

    print("\nChat History:")
    print(json.dumps(history, ensure_ascii=False, indent=2))
    print("\nFeedback Input:")
    print(feedback_content)

    # 4. Process Feedback
    # Core step: Call feedback_server to process user correction information.
    # The system analyzes feedback content, retrieves relevant memories, and generates update operations (e.g., add, modify, or archive old memories).
    res = feedback_server.process_feedback(
        user_id="user_id_001",
        user_name="cube_id_001_0115",
        session_id="session_id",
        chat_history=history,
        feedback_content=feedback_content,
        feedback_time="",
        async_mode="sync",
        corrected_answer="",
        task_id="task_id",
        info={},
    )

    # 5. Feedback Result
    print("\n" + "=" * 50)
    print("Feedback Result")
    print("=" * 50)

    """
    Print feedback processing results, including added or updated memory operations (add/update)
    """
    print(json.dumps(res, ensure_ascii=False, indent=4, default=str))


if __name__ == "__main__":
    main()
