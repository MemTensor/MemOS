"""
Server handlers for MemOS API routers.

This package contains modular handlers for the server_router, responsible for:
- Building component configurations (config_builders)
- Initializing server components (component_init)
- Formatting data for API responses (formatters)
- Handling search, add, scheduler, and chat operations
"""

# Lazy imports to avoid circular dependencies
from memos.api import handlers
from memos.api.handlers import add_handlers, chat_handlers, scheduler_handlers, search_handlers
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
from memos.api.handlers.formatters_handlers import (
    format_memory_item,
    post_process_pref_mem,
    to_iter,
)


__all__ = [
    "add_handlers",
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
    "chat_handlers",
    "format_memory_item",
    "formatters_handlers",
    "handlers",
    "init_server",
    "post_process_pref_mem",
    "scheduler_handlers",
    "search_handlers",
    "to_iter",
]
