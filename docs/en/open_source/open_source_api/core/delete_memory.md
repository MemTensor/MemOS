---
title: Delete Memory
desc: Permanently removes memory entries, associated files, or a collection of memories matching specific filter conditions from a designated MemCube.
---

**Endpoint**: `POST /product/delete_memory`
**Description**: This interface is used to maintain the accuracy and compliance of the memory store. When a user requests that specific information be forgotten, when data becomes outdated, or when a specific uploaded file needs to be purged, this interface performs a physical deletion that is synchronized across both the vector database and the graph database.

## 1. Core Mechanism: Cube-Level Physical Cleanup

In the open-source version, delete operations follow strict **MemCube** isolation logic:

* **Scope Restriction**: Via the `writable_cube_ids` parameter, delete operations are strictly confined to the specified memory stores and will never accidentally delete content from other Cubes.
* **Multi-Dimensional Deletion**: Supports concurrent cleanup across three dimensions: **Memory ID** (precise), **File ID** (associated deletion), and **Filter** (conditional logic).
* **Atomic Synchronization**: Delete operations are triggered by **MemoryHandler**, ensuring that the underlying vector index and entity nodes in the graph database are removed synchronously, preventing retrieval "hallucinations".



## 2. Key Parameters
Core parameters are defined as follows:

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`writable_cube_ids`** | `list[str]` | Yes | Specifies the list of target Cubes on which to perform the delete operation. |
| **`memory_ids`** | `list[str]` | No | A list of unique memory identifiers to be deleted. |
| **`file_ids`** | `list[str]` | No | A list of source file identifiers to be deleted. All memories derived from those files will be cleaned up as well. |
| **`filter`** | `object` | No | A logical filter. Supports bulk deletion of memories matching conditions based on tags, metadata, or timestamps. |

## 3. How It Works (MemoryHandler)

1. **Permission & Routing**: The system validates operation permissions via `user_id` and routes the request to **MemoryHandler**.
2. **Storage Location**: Locates the underlying **naive_mem_cube** component based on `writable_cube_ids`.
3. **Dispatch Cleanup Tasks**:
    * **Cleanup by ID**: Directly erases records from the primary database and vector store based on UUID.
    * **Cleanup by Filter**: First retrieves the set of memory IDs matching the conditions, then performs bulk physical removal.
4. **Status Feedback**: Returns a success status upon completion. The deleted content will immediately disappear from the recall scope of the [**Search interface**](./search_memory.md).

## 4. Quick Start

Use `MemOSClient` to perform deletions across different dimensions:

```python
# Initialize the client
client = MemOSClient(api_key="...", base_url="...")

# Scenario 1: Precisely delete a single known incorrect memory
client.delete_memory(
    writable_cube_ids=["user_01_private"],
    memory_ids=["2f40be8f-736c-4a5f-aada-9489037769e0"]
)

# Scenario 2: Bulk-clean all outdated memories under a specific tag
client.delete_memory(
    writable_cube_ids=["kb_finance_2026"],
    filter={"tags": {"contains": "deprecated_policy"}}
)
```
## 5. Important Notes

**Irreversibility**: Delete operations are physical deletions. Once executed successfully, the memory can no longer be recalled via the search interface.

**File Association**: When deleting via `file_ids`, the system automatically traces and cleans up the factual memories and summaries extracted from those files.
