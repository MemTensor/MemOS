"""
DeepSearch Agent Usage Examples

This example demonstrates two ways to initialize DeepSearchMemAgent:
1. Using Factory pattern (recommended)
2. Direct initialization

DeepSearchMemAgent implements iterative deep search, providing comprehensive answers through:
- Query rewriting: Optimize queries based on conversation history
- Iterative retrieval: Collect information through multiple search rounds
- Reflective analysis: Determine if information is sufficient
- Comprehensive response: Generate complete final answers
"""

import os

from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphConfigFactory
from memos.configs.llms import LLMConfigFactory
from memos.configs.mem_agent import MemAgentConfigFactory
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.configs.textual_memory import TreeTextMemoryConfig
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_agent.deepsearch_agent import DeepSearchMemAgent
from memos.mem_agent.factory import MemAgentFactory
from memos.mem_cube.naive_cube import NaiveMemCube
from memos.mem_reader.factory import MemReaderFactory
from memos.memories.memory_manager.memory_manager import MemoryManager
from memos.memories.textual.simple_tree_memory import SimpleTreeTextMemory


logger = get_logger(__name__)


def build_minimal_components():
    """
    Build the minimal component set required for DeepSearchMemAgent.

    Only need to initialize:
    1. LLM - Used for query rewriting, reflection, and final answer generation
    2. NaiveMemCube - Provides text_mem.search interface for memory retrieval

    Returns:
        dict: Dictionary containing llm and naive_mem_cube
    """
    logger.info("Starting to build minimal component set...")

    # 1. Initialize LLM
    llm_config = LLMConfigFactory(
        backend="openai",
        config={
            "model_name": os.getenv("OPENAI_MODEL_NAME", "gpt-4o-mini"),
            "api_key": os.getenv("OPENAI_API_KEY"),
            "base_url": os.getenv("OPENAI_BASE_URL"),
            "temperature": 0.7,
        },
    )
    llm = LLMFactory.from_config(llm_config)
    logger.info("LLM initialization completed")

    # 2. Initialize Embedder (required by text_mem)
    embedder_config = EmbedderConfigFactory(
        backend="universal_api",
        config={
            "model_name": os.getenv("MOS_EMBEDDER_MODEL", "text-embedding-3-small"),
            "api_key": os.getenv("MOS_EMBEDDER_API_KEY"),
            "base_url": os.getenv("MOS_EMBEDDER_API_BASE"),
        },
    )
    embedder = EmbedderFactory.from_config(embedder_config)
    logger.info("Embedder initialization completed")

    # 3. Initialize GraphDB (required by text_mem)
    graph_db_config = GraphConfigFactory(
        backend="polardb",
        config={
            "host": os.getenv("POLAR_DB_HOST", "localhost"),
            "port": int(os.getenv("POLAR_DB_PORT", "5432")),
            "user": os.getenv("POLAR_DB_USER", "root"),
            "password": os.getenv("POLAR_DB_PASSWORD", "123456"),
            "db_name": os.getenv("POLAR_DB_DB_NAME", "shared_memos_db"),
            "user_name": "memos_default",
            "use_multi_db": False,
            "auto_create": True,
            "embedding_dimension": int(os.getenv("EMBEDDING_DIMENSION", 1024)),
        },
    )
    graph_db = GraphStoreFactory.from_config(graph_db_config)
    logger.info("✓ GraphDB init Done")

    # 4. Initialize MemReader (required by text_mem)
    mem_reader_config = MemReaderConfigFactory(
        backend="simple_struct",
        config={
            "llm": {
                "backend": "openai",
                "config": {
                    "model_name": os.getenv("OPENAI_MODEL_NAME", "gpt-4o-mini"),
                    "api_key": os.getenv("OPENAI_API_KEY"),
                    "base_url": os.getenv("OPENAI_BASE_URL"),
                },
            }
        },
    )
    mem_reader = MemReaderFactory.from_config(mem_reader_config)
    logger.info("✓ MemReader init Done")

    # 5. Initialize MemoryManager
    memory_manager = MemoryManager(
        graph_db=graph_db,
        embedder=embedder,
        llm=llm,
        memory_size=1000,
        is_reorganize=False,
    )
    logger.info("✓ MemoryManager init Done")

    # 6. Initialize TextMemory
    text_mem_config = TreeTextMemoryConfig(
        reorganize=False,
        max_depth=3,
    )
    text_mem = SimpleTreeTextMemory(
        llm=llm,
        embedder=embedder,
        mem_reader=mem_reader,
        graph_db=graph_db,
        reranker=None,
        memory_manager=memory_manager,
        config=text_mem_config,
        internet_retriever=None,
    )
    logger.info("✓ TextMemory initialization completed")

    # 7. Create NaiveMemCube
    naive_mem_cube = NaiveMemCube(
        text_mem=text_mem,
        pref_mem=None,
        act_mem=None,
        para_mem=None,
    )
    logger.info("✓ NaiveMemCube creation completed")

    logger.info("All components initialized!")

    return {
        "llm": llm,
        "naive_mem_cube": naive_mem_cube,
        "embedder": embedder,
        "graph_db": graph_db,
        "mem_reader": mem_reader,
    }


def example_1_factory_initialization():
    """
    Example 1: Initialize DeepSearchMemAgent using Factory pattern (recommended)

    Advantages:
    - Separation of configuration and code
    - Easy to manage and modify
    - Support loading from configuration files
    """
    logger.info("\n" + "=" * 60)
    logger.info("Example 1: Initialize using Factory pattern")
    logger.info("=" * 60 + "\n")

    # Build necessary components
    components = build_minimal_components()
    llm = components["llm"]
    naive_mem_cube = components["naive_mem_cube"]

    # Create configuration Factory
    agent_config_factory = MemAgentConfigFactory(
        backend="deep_search",
        config={
            "agent_name": "MyDeepSearchAgent",
            "description": "Intelligent agent for deep search",
            "max_iterations": 3,  # Maximum number of iterations
            "timeout": 60,  # Timeout in seconds
        },
    )

    # Create Agent using Factory
    # Pass text_mem as memory_retriever, it provides search method
    deep_search_agent = MemAgentFactory.from_config(
        config_factory=agent_config_factory, llm=llm, memory_retriever=naive_mem_cube.text_mem
    )

    logger.info("✓ DeepSearchMemAgent created successfully")
    logger.info(f"  - Agent name: {deep_search_agent.config.agent_name}")
    logger.info(f"  - Max iterations: {deep_search_agent.max_iterations}")
    logger.info(f"  - Timeout: {deep_search_agent.timeout} seconds")

    return deep_search_agent, components


def example_3_usage(deep_search_agent, components):
    """
    Example 3: Using DeepSearchMemAgent for search

    Demonstrates how to:
    1. Add memories to the system
    2. Use Agent for deep search
    3. Get comprehensive answers
    """
    logger.info("\n" + "=" * 60)
    logger.info("Example 3: Using DeepSearchMemAgent")
    logger.info("=" * 60 + "\n")

    naive_mem_cube = components["naive_mem_cube"]
    text_mem = naive_mem_cube.text_mem

    # Simulate adding some memories
    logger.info("1. Adding test memories...")
    test_memories = [
        {
            "user_name": "test_user",
            "messages": [
                "Artificial Intelligence is a branch of computer science dedicated to creating systems capable of performing tasks that typically require human intelligence."
            ],
            "source": "manual",
        },
        {
            "user_name": "test_user",
            "messages": [
                "Machine Learning is a subfield of artificial intelligence that enables computers to learn from data and improve performance."
            ],
            "source": "manual",
        },
        {
            "user_name": "test_user",
            "messages": [
                "Deep Learning is a branch of machine learning that uses multi-layer neural networks to handle complex pattern recognition tasks."
            ],
            "source": "manual",
        },
    ]

    for memory in test_memories:
        try:
            text_mem.add(
                user_name=memory["user_name"],
                messages=memory["messages"],
                source=memory.get("source", "manual"),
            )
            logger.info(f"  ✓ Memory added: {memory['messages'][0][:30]}...")
        except Exception as e:
            logger.warning(f"  ✗ Failed to add memory: {e}")

    # Use Agent for search
    logger.info("\n2. Executing deep search...")
    query = "What is the relationship between artificial intelligence and machine learning?"
    logger.info(f"  Query: {query}")

    try:
        response = deep_search_agent.run(
            query=query,
            user_id="test_user",
            history=["Hello", "I want to learn about artificial intelligence"],
        )

        logger.info("\n3. Search results:")
        logger.info("-" * 60)
        logger.info(response)
        logger.info("-" * 60)

    except Exception as e:
        logger.error(f"Error during search: {e}")
        import traceback

        traceback.print_exc()


def example_4_minimal_initialization():
    """
    Example 4: Minimal initialization (using default configuration)

    Use cases:
    - Quick testing
    - Prototype development
    - No need for custom configuration
    """
    logger.info("\n" + "=" * 60)
    logger.info("Example 4: Minimal initialization (default configuration)")
    logger.info("=" * 60 + "\n")

    # Build necessary components
    components = build_minimal_components()
    llm = components["llm"]
    naive_mem_cube = components["naive_mem_cube"]

    # Direct initialization using default configuration
    deep_search_agent = DeepSearchMemAgent(
        llm=llm,
        memory_retriever=naive_mem_cube.text_mem,
        # config parameter omitted, will use default configuration
    )

    logger.info("✓ DeepSearchMemAgent created successfully (using default configuration)")
    logger.info(f"  - Max iterations: {deep_search_agent.max_iterations}")
    logger.info(f"  - Timeout: {deep_search_agent.timeout} seconds")

    return deep_search_agent, components


def main():
    """Main function: Run all examples"""
    logger.info("DeepSearch Agent Usage Examples")
    logger.info("=" * 60)

    # Check environment variables
    required_env_vars = ["OPENAI_API_KEY"]
    missing_vars = [var for var in required_env_vars if not os.getenv(var)]

    if missing_vars:
        logger.error(f"Missing required environment variables: {', '.join(missing_vars)}")
        logger.error("Please set the following environment variables:")
        logger.error("  - OPENAI_API_KEY: OpenAI API key")
        logger.error("  - OPENAI_BASE_URL (optional): OpenAI API base URL")
        logger.error("  - NEBULA_HOST (optional): NebulaGraph host address")
        return

    try:
        # Run Example 1: Factory pattern
        agent_factory, components_factory = example_1_factory_initialization()

        # Run Example 4: Minimal initialization
        agent_minimal, components_minimal = example_4_minimal_initialization()

        # Run Example 3: Actual usage (using agent created with factory method)
        example_3_usage(agent_factory, components_factory)

        logger.info("\n" + "=" * 60)
        logger.info("All examples completed!")
        logger.info("=" * 60)

    except Exception as e:
        logger.error(f"Error running examples: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    main()
