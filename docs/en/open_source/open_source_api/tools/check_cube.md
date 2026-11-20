---
title: Check Cube Existence
desc: Verify whether a specified MemCube ID has been initialized and is available.
---

**Endpoint**: `POST /product/exist_mem_cube_id`
**Description**: This endpoint verifies whether a specified `mem_cube_id` already exists in the system. It acts as a guard for data consistency and is recommended before dynamically creating knowledge bases or allocating storage for new users.

## 1. Core Mechanism: Cube Index Validation

In the MemOS architecture, MemCube existence determines whether subsequent memory operations are valid:

* **Logical validation**: **MemoryHandler** checks the underlying storage index to confirm whether the ID is registered.
* **Cold-start guard**: In on-demand Cube creation scenarios, this endpoint helps decide whether an initial `add` operation is needed to activate the memory space.

## 2. Key Parameters

Request body:

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`mem_cube_id`** | `str` | Yes | Unique MemCube identifier to validate. |

## 3. How It Works (MemoryHandler)

1. **Index passthrough**: **MemoryHandler** receives the request and calls the metadata query interface of the underlying **naive_mem_cube**.
2. **Status lookup**: The system searches persistent storage for the configuration or database record associated with the ID.
3. **Boolean feedback**: The response does not include memory content. It reports whether the Cube is active through `code` or `data`.

## 4. Quick Start

Check the target Cube status with the SDK:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Scenario: confirm that the target knowledge base exists before importing documents.
kb_id = "kb_finance_2026"
res = client.exist_mem_cube_id(mem_cube_id=kb_id)

if res and res.code == 200:
    # Assume data returns a boolean value or an existence object.
    if res.data.get('exists'):
        print(f"MemCube '{kb_id}' is ready.")
    else:
        print(f"MemCube '{kb_id}' has not been initialized.")
```
