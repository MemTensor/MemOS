import os
import pprint

from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory


# Initialize the memory configuration
# This configuration specifies the extractor, vector database, and embedder backend.
# Here we use OpenAI for extraction, Qdrant for vector storage, and Ollama for embedding.
config = MemoryConfigFactory(
    backend="general_text",
    config={
        "extractor_llm": {
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-4o-mini",
                "api_key": os.environ.get("OPENAI_API_KEY"),
                "api_base": os.environ.get(
                    "OPENAI_BASE_URL",
                    os.environ.get("OPENAI_API_BASE", "https://api.openai.com/v1"),
                ),
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

# Create the memory instance from the configuration
m = MemoryFactory.from_config(config)

example_memories = [
    {
        "memory": "I'm a RUCer, I'm happy.",
        "metadata": {
            "key": "happy RUCer",
            "source": "conversation",
            "tags": ["happy"],
            "updated_at": "2025-05-19T00:00:00",
        },
    },
    {
        "memory": "MemOS is awesome!",
        "metadata": {
            "key": "MemOS",
            "source": "conversation",
            "tags": ["awesome"],
            "updated_at": "2025-05-19T00:00:00",
        },
    },
]

example_id = "a19b6caa-5d59-42ad-8c8a-e4f7118435b4"

print("===== Extract memories =====")
# Extract memories from a conversation
# The extractor LLM processes the conversation to identify relevant information.
memories = m.extract(
    [
        {"role": "user", "content": "I love tomatoes."},
        {"role": "assistant", "content": "Great! Tomatoes are delicious."},
    ]
)
pprint.pprint(memories)
print()

print("==== Add memories ====")
# Add the extracted memories to the memory store
m.add(memories)
# Add a manually created memory item
m.add(
    [
        {
            "id": example_id,
            "memory": "User is Chinese.",
            "metadata": {
                "key": "User Nationality",
                "source": "conversation",
                "tags": ["Nationality"],
                "updated_at": "2025-05-18T00:00:00",
            },
        }
    ]
)
print("All memories after addition:")
pprint.pprint(m.get_all())
print()

print("==== Search memories ====")
# Search for memories related to a query
search_results = m.search("Tell me more about the user", top_k=2)
pprint.pprint(search_results)
print()

print("==== Get memories ====")
# Retrieve a specific memory by its ID
print(f"Memory with ID {example_id}:")
pprint.pprint(m.get(example_id))
# Retrieve multiple memories by IDs
print(f"Memories by IDs [{example_id}]:")
pprint.pprint(m.get_by_ids([example_id]))
print()

print("==== Update memories ====")
# Update an existing memory
m.update(
    example_id,
    {
        "id": example_id,
        "memory": "User is Canadian.",
        "metadata": {
            "key": "User Nationality",
            "source": "conversation",
            "tags": ["Nationality"],
            "updated_at": "2025-05-19T00:00:00",
        },
    },
)
print(f"Memory after update (ID {example_id}):")
pprint.pprint(m.get(example_id))
print()

print("==== Dump memory ====")
# Dump the current state of memory to a file
m.dump("tmp/general_mem")
print("Memory dumped to 'tmp/general_mem'.")
print()

print("==== Delete memories ====")
# Delete a memory by its ID
m.delete([example_id])
print("All memories after deletion:")
pprint.pprint(m.get_all())
print()

print("==== Delete all memories ====")
# Clear all memories from the store
m.delete_all()
print("All memories after delete_all:")
pprint.pprint(m.get_all())
print()
