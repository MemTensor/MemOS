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


def _file_memory(memory_id: str, memory: str, source_content: str) -> dict:
    return {
        "id": memory_id,
        "memory": memory,
        "metadata": {
            "memory_type": "LongTermMemory",
            "relativity": 1.0,
            "sources": [{"type": "file", "content": source_content}],
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


def test_rerank_knowledge_mem_combines_memory_and_source_for_chinese_query():
    text_mem = [
        {
            "cube_id": "cube",
            "memories": [_file_memory("mem-1", "抽取后的记忆", "文件中的原文")],
        }
    ]

    reranked = rerank_knowledge_mem(None, "用户的中文问题", text_mem, top_k=1)[0]["memories"]

    assert reranked[0]["memory"] == "记忆：抽取后的记忆，原文：文件中的原文"
    assert reranked[0]["metadata"]["sources"] == []


def test_rerank_knowledge_mem_combines_memory_and_source_for_english_query():
    text_mem = [
        {
            "cube_id": "cube",
            "memories": [_file_memory("mem-1", "extracted memory", "original file text")],
        }
    ]

    reranked = rerank_knowledge_mem(None, "What does the file say?", text_mem, top_k=1)[0][
        "memories"
    ]

    assert reranked[0]["memory"] == ("Memory: extracted memory, Original text: original file text")
    assert reranked[0]["metadata"]["sources"] == []
