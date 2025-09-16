import os
import uuid

from dotenv import load_dotenv

from memos import log
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.reranker import RerankerConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.reranker.factory import RerankerFactory


load_dotenv()
logger = log.get_logger(__name__)


def make_item(text: str) -> TextualMemoryItem:
    """Build a minimal TextualMemoryItem; embedding will be populated later."""
    return TextualMemoryItem(
        id=str(uuid.uuid4()),
        memory=text,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=None,
            session_id=None,
            status="activated",
            type="fact",
            memory_time="2024-01-01",
            source="conversation",
            confidence=100.0,
            tags=[],
            visibility="public",
            updated_at="2025-01-01T00:00:00",
            memory_type="LongTermMemory",
            key="demo_key",
            sources=["demo://example"],
            embedding=[],
            background="demo background...",
        ),
    )


def show_ranked(title: str, ranked: list[tuple[TextualMemoryItem, float]], top_n: int = 5) -> None:
    print(f"\n=== {title} ===")
    for i, (item, score) in enumerate(ranked[:top_n], start=1):
        preview = (item.memory[:80] + "...") if len(item.memory) > 80 else item.memory
        print(f"[#{i}] score={score:.6f} | {preview}")


def main():
    # -------------------------------
    # 1) Build the embedder (real vectors)
    # -------------------------------
    embedder_cfg = EmbedderConfigFactory.model_validate(
        {
            "backend": "universal_api",
            "config": {
                "provider": "openai",  # or "azure"
                "api_key": os.getenv("OPENAI_API_KEY"),
                "model_name_or_path": "text-embedding-3-large",
                "base_url": os.getenv("OPENAI_API_BASE"),  # optional
            },
        }
    )
    embedder = EmbedderFactory.from_config(embedder_cfg)

    # -------------------------------
    # 2) Prepare query + documents
    # -------------------------------
    query = "What is the capital of France?"
    items = [
        make_item("Paris is the capital of France."),
        make_item("Berlin is the capital of Germany."),
        make_item("The capital of Brazil is Brasilia."),
        make_item("Apples and bananas are common fruits."),
        make_item("The Eiffel Tower is a famous landmark in Paris."),
    ]

    # -------------------------------
    # 3) Embed query + docs with real embeddings
    # -------------------------------
    texts_to_embed = [query] + [it.memory for it in items]
    vectors = embedder.embed(texts_to_embed)  # real vectors from your provider/model
    query_embedding = vectors[0]
    doc_embeddings = vectors[1:]

    # attach real embeddings back to items
    for it, emb in zip(items, doc_embeddings, strict=False):
        it.metadata.embedding = emb

    items[0].metadata.user_id = "u_123"
    items[0].metadata.session_id = "s_abc"
    items[0].metadata.tags = [*items[0].metadata.tags, "paris"]

    items[1].metadata.user_id = "u_124"
    items[1].metadata.session_id = "s_xyz"
    items[1].metadata.tags = [*items[1].metadata.tags, "germany"]
    items[2].metadata.user_id = "u_125"
    items[2].metadata.session_id = "s_ss3"
    items[3].metadata.user_id = "u_126"
    items[3].metadata.session_id = "s_ss4"
    items[4].metadata.user_id = "u_127"
    items[4].metadata.session_id = "s_ss5"

    # -------------------------------
    # 4) Rerank with cosine_local (uses your real embeddings)
    # -------------------------------
    cosine_cfg = RerankerConfigFactory.model_validate(
        {
            "backend": "cosine_local",
            "config": {
                # structural boosts (optional): uses metadata.background
                "level_weights": {"topic": 1.0, "concept": 1.0, "fact": 1.0},
                "level_field": "background",
            },
        }
    )
    cosine_reranker = RerankerFactory.from_config(cosine_cfg)

    ranked_cosine = cosine_reranker.rerank(
        query=query,
        graph_results=items,
        top_k=10,
        query_embedding=query_embedding,  # required by cosine_local
    )
    show_ranked("CosineLocal Reranker (with real embeddings)", ranked_cosine, top_n=5)

    # -------------------------------
    # 5) (Optional) Rerank with HTTP BGE (OpenAI-style /query+documents)
    #     Requires the service URL; no need for embeddings here
    # -------------------------------
    bge_url = os.getenv("BGE_RERANKER_URL")  # e.g., "http://xxx.x.xxxxx.xxx:xxxx/v1/rerank"
    if bge_url:
        http_cfg = RerankerConfigFactory.model_validate(
            {
                "backend": "http_bge",
                "config": {
                    "url": bge_url,
                    "model": os.getenv("BGE_RERANKER_MODEL", "bge-reranker-v2-m3"),
                    "timeout": int(os.getenv("BGE_RERANKER_TIMEOUT", "10")),
                    "boost_weights": {"user_id": 0.5, "tags": 0.2},
                },
            }
        )
        http_reranker = RerankerFactory.from_config(http_cfg)

        ranked_http = http_reranker.rerank(
            query=query,
            graph_results=items,  # uses item.memory internally as documents
            top_k=10,
        )
        show_ranked("HTTP BGE Reranker (OpenAI-style API)", ranked_http, top_n=5)

        # --- NEW: search_filter with rerank ---
        # hit rule:
        # - user_id == "u_123" → score * (1 + 0.5) = 1.5
        # - tags including "paris" → score * (1 + 0.2) = 1.2
        # - project_id(not exist) → warning unrelated with score
        search_filter = {"session_id": "germany", "tags": "germany", "project_id": "demo-p1"}
        ranked_http_boosted = http_reranker.rerank(
            query=query,
            graph_results=items,
            top_k=10,
            search_filter=search_filter,
        )
        show_ranked("HTTP BGE Reranker (with search_filter boosts)", ranked_http_boosted, top_n=5)
    else:
        print("\n[Info] Skipped HTTP BGE scenario because BGE_RERANKER_URL is not set.")


if __name__ == "__main__":
    main()
