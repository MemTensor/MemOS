import json
import os

from typing import TYPE_CHECKING, Any

from memos.api.config import APIConfig
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.internet_retriever import InternetRetrieverConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.configs.reranker import RerankerConfigFactory
from memos.configs.vec_db import VectorDBConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_cube.navie import NaiveMemCube
from memos.mem_feedback.simple_feedback import SimpleMemFeedback
from memos.mem_reader.factory import MemReaderFactory
from memos.memories.textual.simple_tree import SimpleTreeTextMemory
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
    InternetRetrieverFactory,
)
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import FastTokenizer


if TYPE_CHECKING:
    from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.factory import RerankerFactory


logger = get_logger(__name__)


def build_graph_db_config(user_id: str = "default") -> dict[str, Any]:
    """
    Build graph database configuration.

    Args:
        user_id: User ID for configuration context (default: "default")

    Returns:
        Validated graph database configuration dictionary
    """
    graph_db_backend_map = {
        "neo4j-community": APIConfig.get_neo4j_community_config(user_id=user_id),
        "neo4j": APIConfig.get_neo4j_config(user_id=user_id),
        "polardb": APIConfig.get_polardb_config(user_id=user_id),
        "postgres": APIConfig.get_postgres_config(user_id=user_id),
    }

    # Support both GRAPH_DB_BACKEND and legacy NEO4J_BACKEND env vars
    graph_db_backend = os.getenv(
        "GRAPH_DB_BACKEND", os.getenv("NEO4J_BACKEND", "neo4j-community")
    ).lower()
    return GraphDBConfigFactory.model_validate(
        {
            "backend": graph_db_backend,
            "config": graph_db_backend_map[graph_db_backend],
        }
    )


def build_vec_db_config() -> dict[str, Any]:
    """
    Build vector database configuration.

    Returns:
        Validated vector database configuration dictionary
    """
    return VectorDBConfigFactory.model_validate(
        {
            "backend": "milvus",
            "config": APIConfig.get_milvus_config(),
        }
    )


def build_llm_config() -> dict[str, Any]:
    """
    Build LLM configuration.

    Returns:
        Validated LLM configuration dictionary
    """
    return LLMConfigFactory.model_validate(
        {
            "backend": "openai",
            "config": APIConfig.get_openai_config(),
        }
    )


def build_chat_llm_config() -> list[dict[str, Any]]:
    """
    Build chat LLM configuration.

    Returns:
        Validated chat LLM configuration dictionary
    """
    configs = json.loads(os.getenv("CHAT_MODEL_LIST", "[]"))
    return [
        {
            "config_class": LLMConfigFactory.model_validate(
                {
                    "backend": cfg.get("backend", "openai"),
                    "config": (
                        {k: v for k, v in cfg.items() if k not in ["backend", "support_models"]}
                    )
                    if cfg
                    else APIConfig.get_openai_config(),
                }
            ),
            "support_models": cfg.get("support_models", None),
        }
        for cfg in configs
    ]


def build_embedder_config() -> dict[str, Any]:
    """
    Build embedder configuration.

    Returns:
        Validated embedder configuration dictionary
    """
    return EmbedderConfigFactory.model_validate(APIConfig.get_embedder_config())


def build_mem_reader_config() -> dict[str, Any]:
    """
    Build memory reader configuration.

    Returns:
        Validated memory reader configuration dictionary
    """
    return MemReaderConfigFactory.model_validate(
        APIConfig.get_product_default_config()["mem_reader"]
    )


def build_reranker_config() -> dict[str, Any]:
    """
    Build reranker configuration.

    Returns:
        Validated reranker configuration dictionary
    """
    return RerankerConfigFactory.model_validate(APIConfig.get_reranker_config())


def build_feedback_reranker_config() -> dict[str, Any]:
    """
    Build reranker configuration.

    Returns:
        Validated reranker configuration dictionary
    """
    return RerankerConfigFactory.model_validate(APIConfig.get_feedback_reranker_config())


def build_internet_retriever_config() -> dict[str, Any]:
    """
    Build internet retriever configuration.

    Returns:
        Validated internet retriever configuration dictionary
    """
    return InternetRetrieverConfigFactory.model_validate(APIConfig.get_internet_config())


def _get_default_memory_size(cube_config: Any) -> dict[str, int]:
    """
    Get default memory size configuration.

    Attempts to retrieve memory size from cube config, falls back to defaults
    if not found.

    Args:
        cube_config: The cube configuration object

    Returns:
        Dictionary with memory sizes for different memory types
    """
    return getattr(cube_config.text_mem.config, "memory_size", None) or {
        "WorkingMemory": 20,
        "LongTermMemory": 1500,
        "UserMemory": 480,
    }


def _init_chat_llms(chat_llm_configs: list[dict]) -> dict[str, Any]:
    """
    Initialize chat language models from configuration.

    Args:
        chat_llm_configs: List of chat LLM configuration dictionaries

    Returns:
        Dictionary mapping model names to initialized LLM instances
    """

    def _list_models(client):
        try:
            models = (
                [model.id for model in client.models.list().data]
                if client.models.list().data
                else client.models.list().models
            )
        except Exception as e:
            logger.error(f"Error listing models: {e}")
            models = []
        return models

    model_name_instrance_maping = {}
    for cfg in chat_llm_configs:
        llm = LLMFactory.from_config(cfg["config_class"])
        if cfg["support_models"]:
            for model_name in cfg["support_models"]:
                model_name_instrance_maping[model_name] = llm
    return model_name_instrance_maping


def init_components() -> dict[str, Any]:
    # Initialize Redis client first as it is a core dependency for features like scheduler status tracking
    try:
        from memos.mem_scheduler.orm_modules.api_redis_model import APIRedisDBManager

        redis_client = APIRedisDBManager.load_redis_engine_from_env()
        if redis_client:
            logger.info("Redis client initialized successfully.")
        else:
            logger.error(
                "Failed to initialize Redis client. Check REDIS_HOST etc. in environment variables."
            )
    except Exception as e:
        logger.error(f"Failed to initialize Redis client: {e}", exc_info=True)
        redis_client = None  # Ensure redis_client exists even on failure

    # Get default cube configuration
    default_cube_config = APIConfig.get_default_cube_config()

    # Build component configurations
    graph_db_config = build_graph_db_config()
    llm_config = build_llm_config()
    embedder_config = build_embedder_config()
    mem_reader_config = build_mem_reader_config()
    reranker_config = build_reranker_config()
    feedback_reranker_config = build_feedback_reranker_config()
    internet_retriever_config = build_internet_retriever_config()

    logger.debug("Component configurations built successfully")

    # Create component instances
    graph_db = GraphStoreFactory.from_config(graph_db_config)
    llm = LLMFactory.from_config(llm_config)
    embedder = EmbedderFactory.from_config(embedder_config)
    # Pass graph_db to mem_reader for recall operations (deduplication, conflict detection)
    mem_reader = MemReaderFactory.from_config(mem_reader_config, graph_db=graph_db)
    reranker = RerankerFactory.from_config(reranker_config)
    feedback_reranker = RerankerFactory.from_config(feedback_reranker_config)
    internet_retriever = InternetRetrieverFactory.from_config(
        internet_retriever_config, embedder=embedder
    )

    # Initialize chat llms
    logger.debug("Core components instantiated")

    # Initialize memory manager
    memory_manager = MemoryManager(
        graph_db,
        embedder,
        llm,
        memory_size=_get_default_memory_size(default_cube_config),
        is_reorganize=getattr(default_cube_config.text_mem.config, "reorganize", False),
    )

    logger.debug("Memory manager initialized")

    tokenizer = FastTokenizer()
    # Initialize text memory
    text_mem = SimpleTreeTextMemory(
        llm=llm,
        embedder=embedder,
        mem_reader=mem_reader,
        graph_db=graph_db,
        reranker=reranker,
        memory_manager=memory_manager,
        config=default_cube_config.text_mem.config,
        internet_retriever=internet_retriever,
        tokenizer=tokenizer,
    )

    logger.debug("Text memory initialized")

    # Create MemCube with pre-initialized memory instances
    naive_mem_cube = NaiveMemCube(
        text_mem=text_mem,
        act_mem=None,
        para_mem=None,
    )

    tree_mem: SimpleTreeTextMemory = naive_mem_cube.text_mem
    searcher: Searcher = tree_mem.get_searcher(
        manual_close_internet=os.getenv("ENABLE_INTERNET", "true").lower() == "false",
        moscube=False,
        process_llm=mem_reader.general_llm,
    )
    # Initialize feedback server
    feedback_server = SimpleMemFeedback(
        llm=llm,
        embedder=embedder,
        graph_store=graph_db,
        memory_manager=memory_manager,
        mem_reader=mem_reader,
        searcher=searcher,
        reranker=feedback_reranker,
        pref_feedback=True,
    )
    # Return all components as a dictionary for easy access and extension
    return {"naive_mem_cube": naive_mem_cube, "feedback_server": feedback_server}
