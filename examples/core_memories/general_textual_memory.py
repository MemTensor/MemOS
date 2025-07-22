from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory

config = MemoryConfigFactory(
    backend="general_text",
    config={
        "extractor_llm": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "qwen3:0.6b",
                "temperature": 0.0,
                "remove_think_prefix": True,
                "max_tokens": 8192,
            },
        },
        "vector_db": {
            "backend": "qdrant",
            "config": {
                "collection_name": "test_textual_memory",
                "distance_metric": "cosine",
                "vector_dimension": 768,  # nomic-embed-text model's embedding dimension is 768
            },
        },
        "embedder": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "nomic-embed-text:latest",
            },
        },
    },
)
m = MemoryFactory.from_config(config)

example_memories = [
    {
        "memory": "I'm a RUCer, I'm happy.",
        "metadata": {
            "title": "happy RUCer",
            "source": "conversation",
            "tags": ["happy"],
            "updated_at": "2025-05-19T00:00:00",
        },
    },
    {
        "memory": "MemOS is awesome!",
        "metadata": {
            "title": "MemOS",
            "source": "conversation",
            "tags": ["awesome"],
            "updated_at": "2025-05-19T00:00:00",
        },
    },
]
example_id = "a19b6caa-5d59-42ad-8c8a-e4f7118435b4"

print("===== Extract memories =====")
memories = m.extract(
    [
        {"role": "user", "content": "I love tomatoes."},
        {"role": "assistant", "content": "Great! Tomatoes are delicious."},
    ]
)
print(memories)
print()

print("==== Add memories ====")
m.add(memories)
m.add(
    [
        {
            "id": example_id,
            "memory": "User is Chinese.",
            "metadata": {
                "title": "User Nationality",
                "source": "conversation",
                "tags": ["Nationality"],
                "updated_at": "2025-05-18T00:00:00"},
        }
    ]
)
print(m.get_all())
print()
print("==== Search memories ====")
search_results = m.search("Tell me more about the user", top_k=2)
print(search_results)
print()

print("==== Get memories ====")
print(m.get(example_id))
print(m.get_by_ids([example_id]))
print()

print("==== Update memories ====")
m.update(
    example_id,
    {
        "id": example_id,
        "memory": "User is Canadian.",
        "metadata": {
            "title": "User Nationality",
            "source": "conversation",
            "tags": ["Nationality"],
            "updated_at": "2025-05-19T00:00:00",
        },
    },
)
print(m.get(example_id))
print()

print("==== Delete memories ====")
m.delete([example_id])
print(m.get_all())
print()

print("==== Delete all memories ====")
m.delete_all()
print(m.get_all())
print()

print("==== Dump memory ====")
m.dump("tmp/mem")
print("Memory dumped to 'tmp/mem'.")
