from memos.api.handlers.formatters_handler import rerank_knowledge_mem
from memos.api.product_models import APISearchRequest
from memos.plugins.hook_defs import H, get_hook_spec


def _memory(memory_id: str, memory: str, memory_type: str = "LongTermMemory") -> dict:
    return {
        "id": memory_id,
        "memory": memory,
        "metadata": {
            "memory_type": memory_type,
            "relativity": 1.0,
            "sources": [{"content": f"source for {memory}"}],
        },
    }


def test_search_request_passes_context_format_through_to_plugins():
    req = APISearchRequest(
        user_id="user",
        query="What did Maria buy?",
        context_format="plugin-owned-format",
    )

    assert req.context_format == "plugin-owned-format"


def test_search_pipeline_hook_specs_are_registered():
    after_rerank = get_hook_spec(H.SEARCH_RESULTS_AFTER_RERANK)
    render = get_hook_spec(H.SEARCH_CONTEXT_RENDER)

    assert after_rerank is not None
    assert after_rerank.pipe_key == "results"
    assert after_rerank.params == ["handler", "search_req", "results"]

    assert render is not None
    assert render.pipe_key == "results"
    assert render.params == ["handler", "search_req", "results"]


def test_rerank_knowledge_mem_preserves_conversation_sources_by_default():
    text_mem = [
        {
            "cube_id": "cube",
            "memories": [
                _memory("mem-1", "conversation memory", memory_type="WorkingMemory"),
                _memory("mem-2", "knowledge memory", memory_type="LongTermMemory"),
            ],
        }
    ]

    reranked = rerank_knowledge_mem(None, "query", text_mem, top_k=2)[0]["memories"]

    conversation = next(item for item in reranked if item["memory"] == "conversation memory")
    assert conversation["metadata"]["sources"] == [{"content": "source for conversation memory"}]


def test_rerank_knowledge_mem_can_strip_conversation_sources():
    text_mem = [
        {
            "cube_id": "cube",
            "memories": [
                _memory("mem-1", "conversation memory", memory_type="WorkingMemory"),
                _memory("mem-2", "knowledge memory", memory_type="LongTermMemory"),
            ],
        }
    ]

    reranked = rerank_knowledge_mem(
        None,
        "query",
        text_mem,
        top_k=2,
        strip_conversation_sources=True,
    )[0]["memories"]

    conversation = next(item for item in reranked if item["memory"] == "conversation memory")
    assert conversation["metadata"]["sources"] == []
