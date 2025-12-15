"""
Server component initialization module.

This module handles the initialization of all MemOS server components
including databases, LLMs, memory systems, and schedulers.
"""

import os

from typing import TYPE_CHECKING, Any

from memos.api.config import APIConfig
from memos.api.handlers.config_builders import (
    build_chat_llm_config,
    build_embedder_config,
    build_graph_db_config,
    build_internet_retriever_config,
    build_llm_config,
    build_mem_reader_config,
    build_pref_adder_config,
    build_pref_extractor_config,
    build_pref_retriever_config,
    build_reranker_config,
    build_vec_db_config,
)
from memos.configs.mem_scheduler import SchedulerConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_cube.navie import NaiveMemCube
from memos.mem_feedback.simple_feedback import SimpleMemFeedback
from memos.mem_os.product_server import MOSServer
from memos.mem_reader.factory import MemReaderFactory
from memos.mem_scheduler.orm_modules.base_model import BaseDBManager
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.memories.textual.prefer_text_memory.factory import (
    AdderFactory,
    ExtractorFactory,
    RetrieverFactory,
)
from memos.memories.textual.simple_preference import SimplePreferenceTextMemory
from memos.memories.textual.simple_tree import SimpleTreeTextMemory
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import FastTokenizer


if TYPE_CHECKING:
    from memos.memories.textual.tree import TreeTextMemory
from memos.mem_agent.deepsearch_agent import DeepSearchMemAgent
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
    InternetRetrieverFactory,
)
from memos.reranker.factory import RerankerFactory
from memos.vec_dbs.factory import VecDBFactory


if TYPE_CHECKING:
    from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler
    from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
logger = get_logger(__name__)


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


def init_server() -> dict[str, Any]:
    """
    Initialize all server components and configurations.

    This function orchestrates the creation and initialization of all components
    required by the MemOS server, including:
    - Database connections (graph DB, vector DB)
    - Language models and embedders
    - Memory systems (text, preference)
    - Scheduler and related modules

    Returns:
        A dictionary containing all initialized components with descriptive keys.
        This approach allows easy addition of new components without breaking
        existing code that uses the components.
    """
    logger.info("Initializing MemOS server components...")

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

    # Get online bot setting
    dingding_enabled = APIConfig.is_dingding_bot_enabled()

    # Build component configurations
    graph_db_config = build_graph_db_config()
    llm_config = build_llm_config()
    chat_llm_config = build_chat_llm_config()
    embedder_config = build_embedder_config()
    mem_reader_config = build_mem_reader_config()
    reranker_config = build_reranker_config()
    internet_retriever_config = build_internet_retriever_config()
    vector_db_config = build_vec_db_config()
    pref_extractor_config = build_pref_extractor_config()
    pref_adder_config = build_pref_adder_config()
    pref_retriever_config = build_pref_retriever_config()

    logger.debug("Component configurations built successfully")

    # Create component instances
    graph_db = GraphStoreFactory.from_config(graph_db_config)
    vector_db = (
        VecDBFactory.from_config(vector_db_config)
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false") == "true"
        else None
    )
    llm = LLMFactory.from_config(llm_config)
    chat_llms = _init_chat_llms(chat_llm_config)
    embedder = EmbedderFactory.from_config(embedder_config)
    mem_reader = MemReaderFactory.from_config(mem_reader_config)
    reranker = RerankerFactory.from_config(reranker_config)
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

    # Initialize preference memory components
    pref_extractor = (
        ExtractorFactory.from_config(
            config_factory=pref_extractor_config,
            llm_provider=llm,
            embedder=embedder,
            vector_db=vector_db,
        )
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false") == "true"
        else None
    )

    pref_adder = (
        AdderFactory.from_config(
            config_factory=pref_adder_config,
            llm_provider=llm,
            embedder=embedder,
            vector_db=vector_db,
            text_mem=text_mem,
        )
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false") == "true"
        else None
    )

    pref_retriever = (
        RetrieverFactory.from_config(
            config_factory=pref_retriever_config,
            llm_provider=llm,
            embedder=embedder,
            reranker=reranker,
            vector_db=vector_db,
        )
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false") == "true"
        else None
    )

    logger.debug("Preference memory components initialized")

    # Initialize preference memory
    pref_mem = (
        SimplePreferenceTextMemory(
            extractor_llm=llm,
            vector_db=vector_db,
            embedder=embedder,
            reranker=reranker,
            extractor=pref_extractor,
            adder=pref_adder,
            retriever=pref_retriever,
        )
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false") == "true"
        else None
    )

    logger.debug("Preference memory initialized")

    # Initialize MOS Server
    mos_server = MOSServer(
        mem_reader=mem_reader,
        llm=llm,
        online_bot=False,
    )

    logger.debug("MOS server initialized")

    # Create MemCube with pre-initialized memory instances
    naive_mem_cube = NaiveMemCube(
        text_mem=text_mem,
        pref_mem=pref_mem,
        act_mem=None,
        para_mem=None,
    )

    logger.debug("MemCube created")

    tree_mem: TreeTextMemory = naive_mem_cube.text_mem
    searcher: Searcher = tree_mem.get_searcher(
        manual_close_internet=os.getenv("ENABLE_INTERNET", "true").lower() == "false",
        moscube=False,
        process_llm=mem_reader.llm,
    )
    logger.debug("Searcher created")

    # Initialize feedback server
    feedback_server = SimpleMemFeedback(
        llm=llm,
        embedder=embedder,
        graph_store=graph_db,
        memory_manager=memory_manager,
        mem_reader=mem_reader,
        searcher=searcher,
        reranker=reranker,
    )

    # Initialize Scheduler
    scheduler_config_dict = APIConfig.get_scheduler_config()
    scheduler_config = SchedulerConfigFactory(
        backend="optimized_scheduler", config=scheduler_config_dict
    )
    mem_scheduler: OptimizedScheduler = SchedulerFactory.from_config(scheduler_config)
    mem_scheduler.initialize_modules(
        chat_llm=llm,
        process_llm=mem_reader.llm,
        db_engine=BaseDBManager.create_default_sqlite_engine(),
        mem_reader=mem_reader,
        redis_client=redis_client,
    )
    mem_scheduler.init_mem_cube(
        mem_cube=naive_mem_cube, searcher=searcher, feedback_server=feedback_server
    )
    logger.debug("Scheduler initialized")

    # Initialize SchedulerAPIModule
    api_module = mem_scheduler.api_module

    # Start scheduler if enabled
    if os.getenv("API_SCHEDULER_ON", "true").lower() == "true":
        mem_scheduler.start()
        logger.info("Scheduler started")

    logger.info("MemOS server components initialized successfully")

    # Initialize online bot if enabled
    online_bot = None
    if dingding_enabled:
        from memos.memos_tools.notification_service import get_online_bot_function

        online_bot = get_online_bot_function() if dingding_enabled else None
        logger.info("DingDing bot is enabled")

    deepsearch_agent = DeepSearchMemAgent(
        llm=llm,
        memory_retriever=tree_mem,
    )
    # Return all components as a dictionary for easy access and extension
    return {
        "graph_db": graph_db,
        "mem_reader": mem_reader,
        "llm": llm,
        "chat_llms": chat_llms,
        "embedder": embedder,
        "reranker": reranker,
        "internet_retriever": internet_retriever,
        "memory_manager": memory_manager,
        "default_cube_config": default_cube_config,
        "mos_server": mos_server,
        "mem_scheduler": mem_scheduler,
        "naive_mem_cube": naive_mem_cube,
        "searcher": searcher,
        "api_module": api_module,
        "vector_db": vector_db,
        "pref_extractor": pref_extractor,
        "pref_adder": pref_adder,
        "pref_retriever": pref_retriever,
        "text_mem": text_mem,
        "pref_mem": pref_mem,
        "online_bot": online_bot,
        "feedback_server": feedback_server,
        "redis_client": redis_client,
        "deepsearch_agent": deepsearch_agent,
    }
