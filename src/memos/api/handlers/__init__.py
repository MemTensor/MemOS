"""
Server handlers for MemOS API routers.

This package contains modular handlers for the server_router, responsible for:
- Building component configurations (config_builders)
- Initializing server components (component_init)
- Formatting data for API responses (formatters)
- Handling search, add, scheduler, and chat operations
"""

# Lazy imports to avoid circular dependencies
from memos.api.handlers import (
    add_handler,
    chat_handler,
    memory_handler,
    scheduler_handler,
    search_handler,
    suggestion_handler,
)
from memos.api.handlers.component_init import init_server
from memos.api.handlers.config_builders import (
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
from memos.api.handlers.formatters_handler import (
    format_memory_item,
    post_process_pref_mem,
    to_iter,
)


__all__ = [
    "add_handler",
    "build_embedder_config",
    "build_graph_db_config",
    "build_internet_retriever_config",
    "build_llm_config",
    "build_mem_reader_config",
    "build_pref_adder_config",
    "build_pref_extractor_config",
    "build_pref_retriever_config",
    "build_reranker_config",
    "build_vec_db_config",
    "chat_handler",
    "format_memory_item",
    "formatters_handler",
    "init_server",
    "memory_handler",
    "post_process_pref_mem",
    "scheduler_handler",
    "search_handler",
    "suggestion_handler",
    "to_iter",
]
