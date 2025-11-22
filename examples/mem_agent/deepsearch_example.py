"""
DeepSearch Agent Usage Examples - Simplified Version

This example demonstrates simplified initialization of DeepSearchMemAgent without
external config builders, using APIConfig methods directly.
"""

import os

from typing import Any

from memos.api.config import APIConfig
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.internet_retriever import InternetRetrieverConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.configs.mem_agent import MemAgentConfigFactory
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.configs.reranker import RerankerConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_agent.deepsearch_agent import DeepSearchMemAgent
from memos.mem_agent.factory import MemAgentFactory
from memos.mem_cube.navie import NaiveMemCube
from memos.mem_reader.factory import MemReaderFactory
from memos.memories.textual.simple_tree import SimpleTreeTextMemory
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
    InternetRetrieverFactory,
)
from memos.reranker.factory import RerankerFactory


logger = get_logger(__name__)


def build_minimal_components():
    """
    Build minimal components for DeepSearchMemAgent with simplified configuration.

    This function creates all necessary components using APIConfig methods,
    similar to config_builders.py but inline for easier customization.
    """
    logger.info("Initializing simplified MemOS components...")

    # Build component configurations using APIConfig methods (like config_builders.py)

    # Graph DB configuration - using APIConfig.get_nebular_config()
    graph_db_backend = os.getenv("NEO4J_BACKEND", "polardb").lower()
    graph_db_backend_map = {
        "polardb": APIConfig.get_polardb_config(),
    }
    graph_db_config = GraphDBConfigFactory.model_validate(
        {
            "backend": graph_db_backend,
            "config": graph_db_backend_map[graph_db_backend],
        }
    )

    # LLM configuration - using APIConfig.get_openai_config()
    llm_config = LLMConfigFactory.model_validate(
        {
            "backend": "openai",
            "config": APIConfig.get_openai_config(),
        }
    )

    # Embedder configuration - using APIConfig.get_embedder_config()
    embedder_config = EmbedderConfigFactory.model_validate(APIConfig.get_embedder_config())

    # Memory reader configuration - using APIConfig.get_product_default_config()
    mem_reader_config = MemReaderConfigFactory.model_validate(
        APIConfig.get_product_default_config()["mem_reader"]
    )

    # Reranker configuration - using APIConfig.get_reranker_config()
    reranker_config = RerankerConfigFactory.model_validate(APIConfig.get_reranker_config())

    # Internet retriever configuration - using APIConfig.get_internet_config()
    internet_retriever_config = InternetRetrieverConfigFactory.model_validate(
        APIConfig.get_internet_config()
    )

    logger.debug("Component configurations built successfully")

    # Create component instances
    graph_db = GraphStoreFactory.from_config(graph_db_config)
    llm = LLMFactory.from_config(llm_config)
    embedder = EmbedderFactory.from_config(embedder_config)
    mem_reader = MemReaderFactory.from_config(mem_reader_config)
    reranker = RerankerFactory.from_config(reranker_config)
    internet_retriever = InternetRetrieverFactory.from_config(
        internet_retriever_config, embedder=embedder
    )

    logger.debug("Core components instantiated")

    # Get default cube configuration like component_init.py
    default_cube_config = APIConfig.get_default_cube_config()

    # Get default memory size from cube config (like component_init.py)
    def get_memory_size_from_config(cube_config):
        return getattr(cube_config.text_mem.config, "memory_size", None) or {
            "WorkingMemory": 20,
            "LongTermMemory": 1500,
            "UserMemory": 480,
        }

    memory_size = get_memory_size_from_config(default_cube_config)
    is_reorganize = getattr(default_cube_config.text_mem.config, "reorganize", False)

    # Initialize memory manager with config from APIConfig
    memory_manager = MemoryManager(
        graph_db,
        embedder,
        llm,
        memory_size=memory_size,
        is_reorganize=is_reorganize,
    )
    text_memory_config = default_cube_config.text_mem.config
    text_mem = SimpleTreeTextMemory(
        llm=llm,
        embedder=embedder,
        mem_reader=mem_reader,
        graph_db=graph_db,
        reranker=reranker,
        memory_manager=memory_manager,
        config=text_memory_config,
        internet_retriever=internet_retriever,
    )

    naive_mem_cube = NaiveMemCube(
        text_mem=text_mem,
        pref_mem=None,  # Simplified: no preference memory
        act_mem=None,
        para_mem=None,
    )

    return {
        "llm": llm,
        "naive_mem_cube": naive_mem_cube,
        "embedder": embedder,
        "graph_db": graph_db,
        "mem_reader": mem_reader,
    }


def factory_initialization() -> tuple[DeepSearchMemAgent, dict[str, Any]]:
    # Build necessary components with simplified setup
    components = build_minimal_components()
    llm = components["llm"]
    naive_mem_cube = components["naive_mem_cube"]

    # Create configuration Factory with simplified config
    agent_config_factory = MemAgentConfigFactory(
        backend="deep_search",
        config={
            "agent_name": "SimplifiedDeepSearchAgent",
            "description": "Simplified intelligent agent for deep search",
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


def main():
    agent_factory, components_factory = factory_initialization()
    results = agent_factory.run(
        "Caroline met up with friends, family, and mentors in early July 2023.",
        user_id="locomo_exp_user_0_speaker_b_ct-1118",
    )
    print(results)


if __name__ == "__main__":
    main()
