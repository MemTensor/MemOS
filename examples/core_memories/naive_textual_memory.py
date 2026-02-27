import json
import os
import uuid

from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory


def print_result(title, result):
    """Helper function: Pretty print the result."""
    print(f"\n{'=' * 10} {title} {'=' * 10}")
    if isinstance(result, list | dict):
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    else:
        print(result)


# Configure memory backend with OpenAI extractor
config = MemoryConfigFactory(
    backend="naive_text",
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
            },
        }
    },
)

# Create memory instance
m = MemoryFactory.from_config(config)


# Extract memories from a simulated conversation
memories = m.extract(
    [
        {"role": "user", "content": "I love tomatoes."},
        {"role": "assistant", "content": "Great! Tomatoes are delicious."},
    ]
)
print_result("Extract memories", memories)


# Add the extracted memories to storage
m.add(memories)

# Manually create a memory item and add it
example_id = str(uuid.uuid4())
manual_memory = [{"id": example_id, "memory": "User is Chinese.", "metadata": {"type": "opinion"}}]
m.add(manual_memory)

# Print all current memories
print_result("Add memories (Check all after adding)", m.get_all())


# Search for relevant memories based on the query
search_results = m.search("Tell me more about the user", top_k=2)
print_result("Search memories", search_results)


# Get specific memory item by ID
memory_item = m.get(example_id)
print_result("Get memory", memory_item)


# Update the memory content for the specified ID
m.update(
    example_id,
    {
        "id": example_id,
        "memory": "User is Canadian.",
        "metadata": {"type": "opinion", "confidence": 85},
    },
)
updated_memory = m.get(example_id)
print_result("Update memory", updated_memory)


print("==== Dump memory ====")
# Dump the current state of memory to a file
m.dump("tmp/naive_mem")
print("Memory dumped to 'tmp/naive_mem'.")
print()


# Delete memory with the specified ID
m.delete([example_id])
print_result("Delete memory (Check all after deleting)", m.get_all())


# Delete all memories in storage
m.delete_all()
print_result("Delete all", m.get_all())
