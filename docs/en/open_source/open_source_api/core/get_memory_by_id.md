---
title: Get Memory Detail
desc: Retrieves the complete metadata of a single memory entry via its unique identifier (ID), including confidence score, background context, and usage records.
---

**Endpoint**: `GET /product/get_memory/{memory_id}`
**Description**: This interface allows developers to retrieve all underlying details of a single memory entry. Unlike the search interface which returns summary information, this interface exposes the full lifecycle data of the memory (such as vector synchronization status and AI extraction context), making it a core tool for system management and troubleshooting.

## 1. Why Fetch Memory Details?

* **Metadata Inspection**: View the `confidence` score and `background` context that the AI used when extracting this memory entry.
* **Lifecycle Verification**: Confirm whether the memory's `vector_sync` (vector synchronization) succeeded and check its `updated_at` timestamp.
* **Usage Tracking**: Use `usage` records to trace which sessions recalled this memory and used it to assist generation.


## 2. Key Parameters

This interface uses the standard RESTful path parameter format:

| Parameter | Location | Type | Required | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`memory_id`** | Path | `str` | Yes | The unique identifier (UUID) of the memory. You can obtain this ID from the results of the [**Get Memory List**](./get_memory_list.md) or [**Search**](./search_memory.md) interfaces. |

## 3. How It Works (MemoryHandler)

1. **Direct Query**: The **MemoryHandler** bypasses the business orchestration layer and interacts directly with the underlying core component **naive_mem_cube**.
2. **Data Completion**: The system fetches the complete `metadata` dictionary from the persistent database and returns it without any semantic truncation.

## 4. Response Data Reference

The `data` object in the response body contains the following core fields:

| Field | Description |
| :--- | :--- |
| **`id`** | Unique memory identifier. |
| **`memory`** | The text content of the memory, typically including annotations (e.g., `[user opinion]`). |
| **`metadata.confidence`** | The AI's confidence score when extracting this memory (0.0 - 1.0). |
| **`metadata.type`** | Memory classification, such as `fact` or `preference`. |
| **`metadata.background`** | Detailed description of why the AI extracted this memory and its contextual background. |
| **`metadata.usage`** | A list recording the historical times and contexts in which this memory was used by the model. |
| **`metadata.vector_sync`**| Vector database synchronization status, typically `success`. |

## 5. Quick Start

Use the SDK to fetch memory details:

```python
# Assume the ID of a memory is already known
mem_id = "2f40be8f-736c-4a5f-aada-9489037769e0"

# Fetch the complete details
res = client.get_memory_by_id(memory_id=mem_id)

if res and res.code == 200:
    metadata = res.data.get('metadata', {})
    print(f"Memory Background: {metadata.get('background')}")
    print(f"Sync Status: {metadata.get('vector_sync')}")
```
