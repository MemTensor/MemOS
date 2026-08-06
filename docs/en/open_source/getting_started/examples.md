---
title: MemOS Examples
desc: "Congratulations - you've mastered the Quick Start and built your first working memory! Now it's time to see how far you can take MemOS by combining different memory types and features. Use these curated examples to inspire your own agents, chatbots, or knowledge systems."
---

::card-group

  :::card
  ---
  icon: ri:play-line
  title: Minimal Pipeline
  to: /open_source/getting_started/examples#example-1-minimal-pipeline
  ---
  The smallest working pipeline — add, search, update and dump plaintext memories.
  :::

  :::card
  ---
  icon: ri:tree-line
  title: Adding and retrieving multiple information sources
  to: /open_source/getting_started/examples#example-2-multi-modal
  ---
  Adding multi-source messages—including text, images, files, and tool calls—into memory and enabling their retrieval.
  :::

  :::card
  ---
  icon: ri:apps-line
  title: Multi-Cube addition and retrieval
  to: /open_source/getting_started/examples#example-3-multi-cube
  ---
  Add different memories to different Cubes and retrieve them simultaneously during a search.
  :::

  :::card
  ---
  icon: ri:database-2-line
  title: KVCacheMemory Only
  to: /open_source/getting_started/examples#example-4-kvcachememory-only
  ---
  Speed up sessions with short-term KV cache for fast context injection.
  :::

  :::card
  ---
  icon: hugeicons:share-07
  title: Hybrid TreeText + KVCache
  to: /open_source/getting_started/examples#example-5-hybrid
  ---
  Combine explainable graph memory with fast KV caching in a single MemCube.
  :::

  :::card
  ---
  icon: ri:calendar-check-line
  title: Multi-Memory Scheduling
  to: /open_source/getting_started/examples#example-6-multi-memory-scheduling
  ---
  Run dynamic memory orchestration for multi-user, multi-session agents.
  :::

::


## Example 1: Minimal Pipeline

### When to Use:
- You want the smallest possible working example.
- You only need simple plaintext memories stored in a vector DB and retrieve them.

### Key Points:
- Supports basic personal memory integration and search.

### Full Example Code
```python
import json
from memos.api.routers.server_router import add_memories, search_memories
from memos.api.product_models import APIADDRequest, APISearchRequest

user_id = "test_user_1"
add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_1"],
    messages = [
      {"role": "user", "content": "I’ve planned to travel to Guangzhou during the summer vacation. What chain hotels are available for accommodation?"},
      {"role": "assistant", "content": "You can consider [7 Days Inn, Ji Hotel, Hilton], etc."},
      {"role": "user", "content": "I’ll choose 7 Days Inn."},
      {"role": "assistant", "content": "Okay, feel free to ask me if you have any other questions."}
    ],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)
print("add_memories rsp: \n\n", add_rsp)

search_req = APISearchRequest(
    user_id=user_id,
    readable_cube_ids=["cube_test_user_1"],
    query="Please recommend a hotel that I haven’t stayed at before.",
    include_preference=True,
)

search_rsp = search_memories(search_req).data
print("\n\nsearch_rsp: \n\n", json.dumps(search_rsp, indent=2, ensure_ascii=False))
```

##  Example 2: Adding and retrieving multi-source memories

### When to Use:
- In addition to plain text conversations, you need to add files, image content, or tool call history to memory.
- At the same time, you want to retrieve memories from these multiple sources.

### Key Points:
- Adding memories from multiple information sources.
- Needs to include downloadable file and image URLs.
- The added information must strictly follow the OpenAI Messages format.
- The tool schema in the system prompt needs to be wrapped in <tool_schema> </tool_schema>.

### Full Example Code
Adding text and files to memory
```python
import json
from memos.api.routers.server_router import add_memories, search_memories
from memos.api.product_models import APIADDRequest, APISearchRequest

user_id = "test_user_2"
add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_2"],
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Please read this file, summarize the key points, and provide a final conclusion."
                },
                {
                    "type": "file",
                    "file": {
                    "file_id": "file_123",
                    "filename": "report.md",
                    "file_data": "@http://139.196.232.20:9090/graph-test/algorithm/2025_11_13/1763043889_1763043782_PM1%E8%BD%A6%E9%97%B4PMT%E9%9D%B4%E5%8E%8B%E8%BE%B9%E5%8E%8B%E5%8E%8B%E5%8A%9B%E6%97%A0%E6%B3%95%E5%BB%BA%E7%AB%8B%E6%95%85%E9%9A%9C%E6%8A%A5%E5%91%8A20240720.md"
                    }
                },
            ]
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "Final Summary: During the PMT boot-pressure startup test of the PM1 workshop on July 20, 2024, the drive could not run because the edge pressures on both sides failed to reach the 2.5-bar interlock requirement. After troubleshooting, the PLC output signals, hydraulic pipelines, and valves were all found to be normal. The root cause was ultimately identified as poor contact at the negative terminal of the proportional valve’s DC 24V power supply inside the PLC cabinet, caused by a short-jumpered terminal block. After re-connecting the negative incoming lines in parallel, the equipment returned to normal operation. It is recommended to replace terminal blocks in batches, inspect instruments with uncertain service life, and optimize the troubleshooting process by tracing common-mode issues from shared buses and power supply sources."
                }
            ]
        }
    ],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)
print("add_memories rsp: \n\n", add_rsp)

search_req = APISearchRequest(
    user_id=user_id,
    readable_cube_ids=["cube_test_user_2"],
    query="Workshop PMT boot pressure startup test",
    include_preference=False,
)
search_rsp = search_memories(search_req).data
print("\n\nsearch_rsp: \n\n", json.dumps(search_rsp, indent=2, ensure_ascii=False))
```
Adding messages from multiple mixed information sources to memory
```python
import json
from memos.api.routers.server_router import add_memories, search_memories
from memos.api.product_models import APIADDRequest, APISearchRequest

user_id = "test_user_2"
add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_2"],
    messages = [
  {
    "role": "system",
    "content": [
      {
        "type": "text",
        "text": "You are a professional industrial fault analysis assistant. Please read the PDF, images, and instructions provided by the user and provide a professional technical summary.\n\n<tool_schema>\n[\n  {\n    \"name\": \"file_reader\",\n    \"description\": \"Used to read the content of files uploaded by the user and return the text data (in JSON string format).\",\n    \"parameters\": [\n      {\"name\": \"file_id\", \"type\": \"string\", \"required\": true, \"description\": \"The file ID to be read\"}\n    ],\n    \"returns\": {\"type\": \"text\", \"description\": \"Returns the extracted text content of the file\"}\n  }\n]\n</tool_schema>"
      }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "Please read this file and image, summarize the key points, and provide a final conclusion."
      },
      {
        "type": "file",
        "file": {
          "file_id": "file_123",
          "filename": "report.pdf",
          "file_data": "@http://139.196.232.20:9090/graph-test/algorithm/2025_11_13/1763043889_1763043782_PM1%E8%BD%A6%E9%97%B4PMT%E9%9D%B4%E5%8E%8B%E8%BE%B9%E5%8E%8B%E5%8E%8B%E5%8A%9B%E6%97%A0%E6%B3%95%E5%BB%BA%E7%AB%8B%E6%95%85%E9%9A%9C%E6%8A%A5%E5%91%8A20240720.md"
        }
      },
      {
        "type": "image_url",
        "image_url": {
          "url": "https://play-groud-test-1.oss-cn-shanghai.aliyuncs.com/%E5%9B%BE%E7%89%871.jpeg"
        }
      }
    ]
  },
  {
    "role": "assistant",
    "tool_calls": [
      {
        "id": "call_file_reader_001",
        "type": "function",
        "function": {
          "name": "file_reader",
          "arguments": "{\"file_id\": \"file_123\"}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_file_reader_001",
    "content": [
      {
        "type": "text",
        "text": "{\"file_id\":\"file_123\",\"extracted_text\":\"PM1 workshop PMT boot pressure startup test record… Final fault cause: poor contact at the negative terminal of the DC 24V power supply circuit due to a short-jumped terminal block.\"}"
      }
    ]
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Final Summary: During the PMT boot-pressure startup test of the PM1 workshop on July 20, 2024, the drive could not run because the edge pressures on both sides failed to reach the 2.5-bar interlock requirement. After troubleshooting, the PLC output signals, hydraulic pipelines, and valves were all found to be normal. The root cause was ultimately identified as poor contact at the negative terminal of the proportional valve’s DC 24V power supply inside the PLC cabinet, caused by a short-jumpered terminal block. After re-connecting the negative incoming lines in parallel, the equipment returned to normal operation. It is recommended to replace terminal blocks in batches, inspect instruments with uncertain service life, and optimize the troubleshooting process by tracing common-mode issues from shared buses and power supply sources."
      }
    ]
  }
],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)

print("add_memories rsp: \n\n", add_rsp)



search_req = APISearchRequest(
    user_id=user_id,
    readable_cube_ids=["cube_test_user_2"],
    query="Workshop PMT boot pressure startup test",
    include_preference=False,
)

search_rsp = search_memories(search_req).data
print("\n\nsearch_rsp: \n\n", json.dumps(search_rsp, indent=2, ensure_ascii=False))
```

## Example 3: Multi-Cube addition and retrieval

### When to Use:

- Add memories to separate, isolated Cube spaces
- You want to retrieve memories from different Cube spaces simultaneously

### Key Points:

- Input a readable_cube_ids list containing multiple cube IDs during retrieval

### Full Example Code

```python
import json
from memos.api.routers.server_router import add_memories, search_memories
from memos.api.product_models import APIADDRequest, APISearchRequest

user_id = "test_user_3"
add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_3_1"] ,
    messages = [
      {"role": "user", "content": "I’ve planned to travel to Guangzhou during the summer vacation. What chain hotels are available for accommodation?"},
      {"role": "assistant", "content": "You can consider [7 Days Inn, Ji Hotel, Hilton], etc."},
      {"role": "user", "content": "I’ll choose 7 Days Inn."},
      {"role": "assistant", "content": "Okay, feel free to ask me if you have any other questions."}
    ],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)
print("add_memories rsp: \n\n", add_rsp)

add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_3_2"] ,
    messages = [
      {"role": "user", "content": "I love you, I need you."},
      {"role": "assistant", "content": "Wow, I love you too"},
    ],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)
print("add_memories rsp: \n\n", add_rsp)

search_req = APISearchRequest(
    user_id=user_id,
    readable_cube_ids=["cube_test_user_3_1", "cube_test_user_3_2"],
    query="Please recommend a hotel, Love u u",
    include_preference=True,
)

search_rsp = search_memories(search_req).data
print("\n\nsearch_rsp: \n\n", json.dumps(search_rsp, indent=2, ensure_ascii=False))
```

## Example 4: KVCacheMemory Only

### When to Use:
- You want short-term working memory for faster multi-turn conversation.
- Useful for chatbot session acceleration or prompt reuse.
- Best for caching hidden states / KV pairs.

### Key Points:
- Uses KVCacheMemory with no explicit text memory.
- Demonstrates extract → add → merge → get → delete.
- Shows how to dump/load KV caches.

### Full Example Code

```python
from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory

# Create config for KVCacheMemory (HuggingFace backend)
config = MemoryConfigFactory(
    backend="kv_cache",
    config={
        "extractor_llm": {
            "backend": "huggingface",
            "config": {
                "model_name_or_path": "Qwen/Qwen3-0.6B",
                "max_tokens": 32,
                "add_generation_prompt": True,
                "remove_think_prefix": True,
            },
        },
    },
)

# Instantiate KVCacheMemory
kv_mem = MemoryFactory.from_config(config)

# Extract a KVCacheItem (DynamicCache)
prompt = [
    {"role": "user", "content": "What is MemOS?"},
    {"role": "assistant", "content": "MemOS is a memory operating system for LLMs."},
]
print("===== Extract KVCacheItem =====")
cache_item = kv_mem.extract(prompt)
print(cache_item)

# Add the cache to memory
kv_mem.add([cache_item])
print("All caches:", kv_mem.get_all())

# Get by ID
retrieved = kv_mem.get(cache_item.id)
print("Retrieved:", retrieved)

# Merge caches (simulate multi-turn)
item2 = kv_mem.extract([{"role": "user", "content": "Tell me a joke."}])
kv_mem.add([item2])
merged = kv_mem.get_cache([cache_item.id, item2.id])
print("Merged cache:", merged)

# Delete one
kv_mem.delete([cache_item.id])
print("After delete:", kv_mem.get_all())

# Dump & load caches
kv_mem.dump("tmp/kv_mem")
print("Dumped to tmp/kv_mem")
kv_mem.delete_all()
kv_mem.load("tmp/kv_mem")
print("Loaded caches:", kv_mem.get_all())
```

## Example 5: Hybrid

### When to Use:
- You want long-term explainable memory and short-term fast context together.
- Ideal for complex agents that plan, remember facts, and keep chat context.
- Demonstrates multi-memory orchestration.

### How It Works:

- **TreeTextMemory** stores your long-term knowledge in a graph DB (Neo4j).
- **KVCacheMemory** stores recent or stable context as activation caches.
- Both work together in a single **MemCube**, managed by your `MOS` pipeline.


###  Full Example Code

```python
import os

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS

# 1. Setup CUDA (if needed) — for local GPU inference
os.environ["CUDA_VISIBLE_DEVICES"] = "1"

# 2. Define user & paths
user_id = "root"
cube_id = "root/mem_cube_kv_cache"
tmp_cube_path = "/tmp/default/mem_cube_5"

# 3. Initialize MOSConfig
mos_config = MOSConfig.from_json_file("examples/data/config/simple_treekvcache_memos_config.json")
mos = MOS(mos_config)

# 4. Initialize the MemCube (TreeTextMemory + KVCacheMemory)
cube_config = GeneralMemCubeConfig.from_json_file(
    "examples/data/config/simple_treekvcache_cube_config.json"
)
mem_cube = GeneralMemCube(cube_config)

# 5. Dump the MemCube to disk
try:
    mem_cube.dump(tmp_cube_path)
except Exception as e:
    print(e)

# 6. Register the MemCube explicitly
mos.register_mem_cube(tmp_cube_path, mem_cube_id=cube_id, user_id=user_id)

# 7. Extract and add a KVCache memory (simulate stable context)
extract_kvmem = mos.mem_cubes[cube_id].act_mem.extract("I like football")
mos.mem_cubes[cube_id].act_mem.add([extract_kvmem])

# 8. Start chatting — now your chat uses:
#    - TreeTextMemory: for structured multi-hop retrieval
#    - KVCacheMemory: for fast context injection
while True:
    user_input = input("👤 [You] ").strip()
    print()
    response = mos.chat(user_input)
    print(f"🤖 [Assistant] {response}\n")

print("📢 [System] MemChat has stopped.")
```

## Example 6: Multi-Memory Scheduling

### When to Use:
- You want to manage multiple users, multiple MemCubes, or dynamic memory flows.
- Good for SaaS agents or multi-session LLMs.
- Demonstrates MemScheduler + config YAMLs.

### Key Points:
- Uses parse_yaml to load MOSConfig and MemCubeConfig.
- Dynamic user and cube creation.
- Shows runtime scheduling of memories.

### Full Example Code

```python
import shutil
import uuid
from pathlib import Path

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS
from memos.mem_scheduler.utils import parse_yaml

# Load main MOS config with MemScheduler
config = parse_yaml("./examples/data/config/mem_scheduler/memos_config_w_scheduler.yaml")
mos_config = MOSConfig(**config)
mos = MOS(mos_config)

# Create user with dynamic ID
user_id = str(uuid.uuid4())
mos.create_user(user_id=user_id)

# Create MemCube config and dump it
config = GeneralMemCubeConfig.from_yaml_file(
    "./examples/data/config/mem_scheduler/mem_cube_config.yaml"
)
mem_cube_id = "mem_cube_5"
mem_cube_name_or_path = f"./outputs/mem_scheduler/{user_id}/{mem_cube_id}"

# Remove old folder if exists
if Path(mem_cube_name_or_path).exists():
    shutil.rmtree(mem_cube_name_or_path)
    print(f"{mem_cube_name_or_path} is not empty, and has been removed.")

# Dump new cube
mem_cube = GeneralMemCube(config)
mem_cube.dump(mem_cube_name_or_path)

# Register MemCube for this user
mos.register_mem_cube(
    mem_cube_name_or_path=mem_cube_name_or_path,
    mem_cube_id=mem_cube_id,
    user_id=user_id
)

# Add messages
messages = [
    {
        "role": "user",
        "content": "I like playing football."
    },
    {
        "role": "assistant",
        "content": "I like playing football too."
    },
]
mos.add(messages, user_id=user_id, mem_cube_id=mem_cube_id)

# Chat loop: show TreeTextMemory nodes + KVCache
while True:
    user_input = input("👤 [You] ").strip()
    print()
    response = mos.chat(user_input, user_id=user_id)
    retrieved_memories = mos.get_all(mem_cube_id=mem_cube_id, user_id=user_id)

    print(f"🤖 [Assistant] {response}")

    # Show WorkingMemory nodes in TreeTextMemory
    for node in retrieved_memories["text_mem"][0]["memories"]["nodes"]:
        if node["metadata"]["memory_type"] == "WorkingMemory":
            print(f"[WorkingMemory] {node['memory']}")

    # Show Activation Memory
    if retrieved_memories["act_mem"][0]["memories"]:
        for act_mem in retrieved_memories["act_mem"][0]["memories"]:
            print(f"⚡ [KVCache] {act_mem['memory']}")
    else:
        print("⚡ [KVCache] None\n")
```



::note
**Keep in Mind**<br>
Use dump() and load() to persist your memory cubes.

Always check your vector DB dimension matches your embedder.

For graph memory, you'll need Neo4j Desktop (community version support coming soon).
::

## Next Steps
You're just getting started!Next, try:

- Pick the example that matches your use case.
- Combine modules to build smarter, more persistent agents!

Need more?
See the API Reference or contribute your own example!
