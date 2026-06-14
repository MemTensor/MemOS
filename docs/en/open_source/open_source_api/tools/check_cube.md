---
title: Check MemCube Existence
desc: Verify whether a specified MemCube ID has been initialized and is available in the system.
---

**Endpoint Path**: `POST /product/exist_mem_cube_id`
**Description**: This endpoint verifies whether a given `mem_cube_id` already exists in the system. It serves as the "gatekeeper" for data consistency and should be called before dynamically creating a knowledge base or allocating space for a new user, to avoid duplicate initialization or invalid operations.

## 1. Core Mechanism: Cube Index Validation

In the MemOS architecture, the existence of a MemCube determines the validity of all subsequent memory operations:

* **Logical Validation**: The system retrieves the underlying storage index via the **MemoryHandler** to confirm whether the ID is registered.
* **Cold Start Assurance**: For on-demand Cube creation scenarios, this endpoint can determine whether an initial `add` operation is needed to activate the memory space.

## 2. Key Parameters

The request body is defined as follows:

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`mem_cube_id`** | `str` | Yes | The unique identifier of the MemCube to validate. |

## 3. How It Works (MemoryHandler)

1. **Direct Index Access**: Upon receiving the request, the **MemoryHandler** directly calls the metadata query interface of the underlying **naive_mem_cube**.
2. **Status Retrieval**: The system looks up the corresponding configuration file or database record for the ID in the persistence layer.
3. **Boolean Feedback**: The result does not include memory content; it only indicates whether the Cube is activated via `code` or `data`.

## 4. Quick Start Example

Check the target Cube status using the SDK:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Scenario: confirm the target knowledge base exists before importing documents
kb_id = "kb_finance_2026"
res = client.exist_mem_cube_id(mem_cube_id=kb_id)

if res and res.code == 200:
    # ExistMemCubeIdResponse.data is dict[str, bool]: {cube_id: exists}
    if res.data.get(kb_id):
        print(f"MemCube '{kb_id}' is ready.")
    else:
        print(f"MemCube '{kb_id}' has not been initialized.")
```

## 5. cURL Example

```bash
# Check if a MemCube ID is registered
curl -X POST "http://localhost:8000/product/exist_mem_cube_id" \
  -H "Authorization: Token YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mem_cube_id": "kb_finance_2026"}'

# Example response:
# {"code": 200, "message": "Successfully", "data": {"kb_finance_2026": true}}
```

Or using Python `requests`:

```python
import requests

res = requests.post(
    "http://localhost:8000/product/exist_mem_cube_id",
    headers={"Authorization": "Token YOUR_API_KEY", "Content-Type": "application/json"},
    json={"mem_cube_id": "kb_finance_2026"},
)
print(res.json())
```
