import os
import pprint
import uuid

from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory


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

example_memories = [
    {
        "memory": "I'm a RUCer, I'm happy.",
        "metadata": {
            "type": "event",
        },
    },
    {
        "memory": "MemOS is awesome!",
        "metadata": {
            "type": "opinion",
        },
    },
]

example_id = str(uuid.uuid4())

print("==== Add memories ====")
# Add example memories to the memory store
m.add(example_memories)
# Manually create a memory item and add it
m.add(
    [
        {
            "id": example_id,
            "memory": "User is Chinese.",
            "metadata": {"type": "opinion"},
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
# Get specific memory item by ID
print(f"Memory with ID {example_id}:")
pprint.pprint(m.get(example_id))
print(f"Memories by IDs [{example_id}]:")
pprint.pprint(m.get_by_ids([example_id]))
print()

print("==== Update memories ====")
# Update the memory content for the specified ID
m.update(
    example_id,
    {
        "id": example_id,
        "memory": "User is Canadian.",
        "metadata": {"type": "opinion", "confidence": 85},
    },
)
print(f"Memory after update (ID {example_id}):")
pprint.pprint(m.get(example_id))
print()

print("==== Dump memory ====")
# Dump the current state of memory to a file
m.dump("tmp/naive_mem")
print("Memory dumped to 'tmp/naive_mem'.")
print()

print("==== Delete memories ====")
# Delete memory with the specified ID
m.delete([example_id])
print("All memories after deletion:")
pprint.pprint(m.get_all())
print()

print("==== Delete all memories ====")
# Delete all memories in storage
m.delete_all()
print("All memories after delete_all:")
pprint.pprint(m.get_all())
print()
