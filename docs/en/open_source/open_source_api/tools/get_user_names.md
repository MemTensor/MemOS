---
title: Reverse Query User Names
desc: Look up the user name associated with a memory entry by its unique identifier (ID).
---

**Endpoint Path**: `POST /product/get_user_names_by_memory_ids`
**Description**: This endpoint provides a "reverse tracing" capability. When you obtain a specific `memory_id` from system logs or shared storage but cannot determine its origin, you can use this endpoint to batch-retrieve the corresponding user names.

## 1. Core Mechanism: Metadata Tracing

In the MemOS storage architecture, each generated memory entry is bound to the original user's metadata. This endpoint performs tracing through the following logic:

* **Many-to-One Mapping**: Supports passing multiple `memory_id` values in a single request, and returns the corresponding user list.
* **Management Transparency**: This tool is typically used in admin dashboards to help administrators identify contributors of different entries within a shared Cube.

## 2. Key Parameters

The request body is defined as follows:

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`memory_ids`** | `list[str]` | Yes | A list of unique memory identifiers to query. |

## 3. How It Works (MemoryHandler)

1. **ID Resolution**: The **MemoryHandler** receives the list of IDs and queries the global index table.
2. **Relationship Retrieval**: The system extracts the associated `user_id` or `user_name` attributes from the underlying persistence layer (or relationship graph nodes).
3. **Data Masking**: Based on system configuration, returns the appropriate user display name or identifier.

## 4. Quick Start Example

Perform a reverse query using the SDK:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Prepare the list of memory IDs to look up
target_ids = [
    "2f40be8f-736c-4a5f-aada-9489037769e0",
    "5e92be1a-826d-4f6e-97ce-98b699eebb98"
]

# Execute the query
res = client.get_user_names_by_memory_ids(memory_ids=target_ids)

if res and res.code == 200:
    # res.data typically returns a mapping dictionary or user list
    print(f"These memory entries belong to users: {res.data}")
```
