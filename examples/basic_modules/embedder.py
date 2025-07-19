from memos.configs.embedder import EmbedderConfigFactory
from memos.embedders.factory import EmbedderFactory


# Scenario 1: Using EmbedderFactory

config = EmbedderConfigFactory.model_validate(
    {
        "backend": "ollama",
        "config": {
            "model_name_or_path": "nomic-embed-text:latest",
        },
    }
)
embedder = EmbedderFactory.from_config(config)
text = "This is a sample text for embedding generation."
embedding = embedder.embed([text])
print("Scenario 1 embedding shape:", len(embedding[0]))
print("==" * 20)


# Scenario 2: Batch embedding generation

texts = [
    "First sample text for batch embedding.",
    "Second sample text for batch embedding.",
    "Third sample text for batch embedding.",
]
embeddings = embedder.embed(texts)
print("Scenario 2 batch embeddings count:", len(embeddings))
print("Scenario 2 first embedding shape:", len(embeddings[0]))
print("==" * 20)


# Scenario 3: Using SenTranEmbedder

config_hf = EmbedderConfigFactory.model_validate(
    {
        "backend": "sentence_transformer",
        "config": {
            "model_name_or_path": "nomic-ai/nomic-embed-text-v1.5",
        },
    }
)
embedder_hf = EmbedderFactory.from_config(config_hf)
text_hf = "This is a sample text for Hugging Face embedding generation."
embedding_hf = embedder_hf.embed([text_hf])
print("Scenario 3 HF embedding shape:", len(embedding_hf[0]))
print("==" * 20)

# === Scenario 4: Using UniversalAPIEmbedder(OpenAI) ===

config_api = EmbedderConfigFactory.model_validate(
    {
        "backend": "universal_api",
        "config": {
            "provider": "openai",
            "api_key": "<YOUR_KEY>",
            "model_name_or_path": "text-embedding-3-large",
            "base_url": "https://api.myproxy.com/v1",
        },
    }
)
embedder_api = EmbedderFactory.from_config(config_api)
text_api = "This is a sample text for embedding generation using OpenAI API."
embedding_api = embedder_api.embed([text_api])
print("Scenario 4: OpenAI API embedding vector length:", len(embedding_api[0]))
print("Embedding preview:", embedding_api[0][:10])

# === Scenario 5: Using UniversalAPIEmbedder(Azure) ===

config_api = EmbedderConfigFactory.model_validate(
    {
        "backend": "universal_api",
        "config": {
            "provider": "azure",
            "api_key": "<YOUR_AZURE_KEY>",
            "model_name_or_path": "text-embedding-3-large",
            "base_url": "https://open.azure.com/openapi/online/v2/",
        },
    }
)
embedder_api = EmbedderFactory.from_config(config_api)
text_api = "This is a sample text for embedding generation using Azure API."
embedding_api = embedder_api.embed([text_api])
print("Scenario 5: Azure API embedding vector length:", len(embedding_api[0]))
print("Embedding preview:", embedding_api[0][:10])
