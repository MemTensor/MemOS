from __future__ import annotations

from typing import Any


def build_plugin_context(
    *,
    graph_db: Any,
    embedder: Any,
    llm: Any | None = None,
    default_cube_config: Any,
    nli_client_config: dict[str, Any],
    mem_reader_config: Any,
    reranker_config: Any,
    feedback_reranker_config: Any,
    internet_retriever_config: Any,
) -> dict[str, Any]:
    return {
        "shared": {
            "graph_db": graph_db,
            "embedder": embedder,
            "llm": llm,
            "mem_scheduler": None,
            "submit_scheduler_messages": None,
            "api_module": None,
        },
        "configs": {
            "default_cube_config": default_cube_config,
            "nli_client_config": nli_client_config,
            "mem_reader_config": mem_reader_config,
            "reranker_config": reranker_config,
            "feedback_reranker_config": feedback_reranker_config,
            "internet_retriever_config": internet_retriever_config,
        },
    }
