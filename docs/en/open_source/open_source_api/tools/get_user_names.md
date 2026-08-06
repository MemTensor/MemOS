---
title: Get User Names
desc: Look up the user names associated with specific memory IDs.
---

**Endpoint**: `POST /product/get_user_names_by_memory_ids`
**Description**: This endpoint provides reverse tracing. When you have a `memory_id` from logs or shared storage but do not know who created it, use this API to retrieve the corresponding user names in batches.

## 1. Core Mechanism: Metadata Traceback

In the MemOS storage architecture, every generated memory entry is bound to metadata from its original user. This endpoint traces ownership through the following logic:

* **Many-to-one mapping**: Accepts multiple `memory_id` values in one request and returns the associated user list.
* **Administrative transparency**: Commonly used in admin dashboards to identify contributors of different entries in a public Cube.

## 2. Key Parameters

Request body:

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`memory_ids`** | `list[str]` | Yes | List of memory identifiers to query. |

## 3. How It Works (MemoryHandler)

1. **ID parsing**: **MemoryHandler** receives the ID list and queries the global index table.
2. **Relation lookup**: The system extracts associated `user_id` or `user_name` properties from persistent storage or graph nodes.
3. **Data masking**: Depending on system configuration, the response returns user display names or identifiers.

## 4. Quick Start

Run a reverse lookup with the SDK:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Memory IDs to query.
target_ids = [
    "2f40be8f-736c-4a5f-aada-9489037769e0",
    "5e92be1a-826d-4f6e-97ce-98b699eebb98"
]

# Execute the query.
res = client.get_user_names_by_memory_ids(memory_ids=target_ids)

if res and res.code == 200:
    # res.data usually returns a mapping or a user list.
    print(f"These memory fragments belong to: {res.data}")
```
