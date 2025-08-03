"""
Example: Using InternetRetrieverFactory with BochaAISearchRetriever
"""

from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.internet_retriever import InternetRetrieverConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
    InternetRetrieverFactory,
)


# ========= 1. Create an embedder =========
embedder_config = EmbedderConfigFactory.model_validate(
    {
        "backend": "ollama",  # Or "sentence_transformer", etc.
        "config": {
            "model_name_or_path": "nomic-embed-text:latest",
        },
    }
)
embedder = EmbedderFactory.from_config(embedder_config)

# ========= 2. Create retriever config for BochaAI =========
retriever_config = InternetRetrieverConfigFactory.model_validate(
    {
        "backend": "bocha",
        "config": {
            "api_key": "sk-xxx",  # Your BochaAI API Key
            "max_results": 5,
            "reader": {  # Reader config for chunking web content
                "backend": "simple_struct",
                "config": {  # your simple struct reader config
                },
            },
        },
    }
)

# ========= 3. Build retriever instance via factory =========
retriever = InternetRetrieverFactory.from_config(retriever_config, embedder)

# ========= 4. Run BochaAI Web Search =========
print("=== Scenario 1: Web Search (BochaAI) ===")
query_web = "Alibaba 2024 ESG report"
results_web = retriever.retrieve_from_internet(query_web)

print(f"Retrieved {len(results_web)} memory items.")
for idx, item in enumerate(results_web, 1):
    print(f"[{idx}] {item.memory[:500]}...")  # preview first 100 chars

print("==" * 20)
