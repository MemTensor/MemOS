---
title: Search Memory
desc: Recalls the most relevant contextual information from the memory store using semantic retrieval and logical filtering, based on the MemCube isolation mechanism.
---

**Endpoint**: `POST /product/search`
**Description**: This interface is the core of MemOS's Retrieval-Augmented Generation (RAG) capability. It performs semantic matching across multiple isolated **MemCubes**, automatically recalling relevant facts, user preferences, and tool invocation records.

## 1. Core Mechanism: Readable Cubes

Unlike the single-user perspective in cloud services, the open-source interface achieves highly flexible retrieval scope control through **`readable_cube_ids`**:

* **Cross-Cube Retrieval**: You can specify multiple Cube IDs simultaneously (e.g., `[user_private_cube, enterprise_public_kb_cube]`), and the algorithm will recall the most relevant content from these isolated memory stores in parallel.
* **Soft Signal Weighting**: By passing a `session_id`, the system will prioritize content from that session during recall. This acts only as a "weight" to improve relevance, not as a hard filter.
* **Absolute Isolation**: Content from Cubes not included in the `readable_cube_ids` list is completely invisible at the algorithm level, ensuring data security in multi-tenant environments.



## 2. Key Parameters

Core retrieval parameters are defined as follows:

### Retrieval Basics
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`query`** | `str` | Yes | The user's search query string. The system will perform semantic matching based on this. |
| **`user_id`** | `str` | Yes | The unique identifier of the requester, used for authentication and context tracking. |
| **`readable_cube_ids`**| `list[str]`| Yes | **Core parameter**: Specifies the list of Cube IDs that this search can read. |
| **`mode`** | `str` | No | **Search strategy**: Options are `fast`, `fine`, or `mixture`. |

### Recall Control
| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`top_k`** | `int` | `10` | Maximum number of text memories to recall. |
| **`include_preference`**| `bool` | `true` | Whether to recall relevant user preference memories (explicit/implicit preferences). |
| **`search_tool_memory`**| `bool` | `true` | Whether to recall relevant tool invocation records. |
| **`filter`** | `dict` | - | Logical filter supporting precise filtering by tags or metadata. |
| **`dedup`** | `str` | - | Deduplication strategy: `no` (no deduplication), `sim` (semantic deduplication), `None` (default exact text deduplication). |

## 3. How It Works (SearchHandler Strategy)

When a request reaches the backend, **SearchHandler** calls different components based on the specified `mode`:

1. **Query Rewriting**: Uses an LLM to semantically enhance the user's `query`, improving match accuracy.
2. **Multi-Mode Matching**:
    * **Fast Mode**: Performs quick recall via vector index. Suitable for scenarios with extremely high response speed requirements.
    * **Fine Mode**: Adds a reranking step to improve the relevance of recalled content.
    * **Mixture Mode**: Combines semantic search with graph-based search to recall memories with greater depth and association.
3. **Multi-Dimensional Aggregation**: The system retrieves facts, preferences (`pref_top_k`), and tool memories (`tool_mem_top_k`) in parallel and aggregates the results for return.
4. **Post-Processing Deduplication**: Compresses highly similar memory entries based on the `dedup` configuration.

## 4. Quick Start

Perform a multi-Cube joint search via SDK:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Scenario: Search user memories and two specialized knowledge bases simultaneously
res = client.search_memory(
    user_id="sde_dev_01",
    query="Based on my previous preferences, recommend some R language visualization solutions",
    # Pass the list of readable Cubes, including personal space and two knowledge bases
    readable_cube_ids=["user_01_private", "kb_r_lang", "kb_data_viz"],
    mode="fine",             # Use fine mode for more accurate recommendations
    include_preference=True,  # Recall preferences such as "user prefers a minimalist style"
    top_k=5
)

if res:
    # Results are contained in memory_detail_list
    print(f"Recall results: {res.data}")
```

## 5. Advanced: Using Filters
SearchHandler supports complex filters to meet more granular business requirements:
```python

# Example: Search only for memories tagged "Programming" and created after 2026
search_filter = {
    "and": [
        {"tags": {"contains": "Programming"}},
        {"created_at": {"gt": "2026-01-01"}}
    ]
}

res = client.search_memory(
    query="data cleaning logic",
    user_id="sde_dev_01",
    readable_cube_ids=["user_01_private"],
    filter=search_filter
)
```
