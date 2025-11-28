## Product API smoke tests (local 0.0.0.0:8001)

Source: https://github.com/MemTensor/MemOS/issues/518

### Prerequisites
- Service is running: `python -m uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8001`
- `.env` is configured for Redis, embeddings, and the vector DB (current test setup: Redis reachable, Qdrant Cloud connected).

### 1) /product/add
- Purpose: Write a memory (sync/async).
- Example request (sync):

  ```bash
  curl -s -X POST http://127.0.0.1:8001/product/add \
    -H 'Content-Type: application/json' \
    -d '{
          "user_id": "tester",
          "mem_cube_id": "default_cube",
          "memory_content": "Apple is a fruit rich in fiber.",
          "async_mode": "sync"
        }'
  ```

- Observed result: `200`, message: "Memory added successfully", returns the written `memory_id` and related info.

### 2) /product/get_all
- Purpose: List all memories for the user/type to confirm writes.
- Example request:

  ```bash
  curl -s -X POST http://127.0.0.1:8001/product/get_all \
    -H 'Content-Type: application/json' \
    -d '{
          "user_id": "tester",
          "memory_type": "text_mem",
          "mem_cube_ids": ["default_cube"]
        }'
  ```

- Observed result: `200`, shows the recently written apple memories (WorkingMemory/LongTermMemory/UserMemory present, `vector_sync=success`).

### 3) /product/search
- Purpose: Vector search memories.
- Example request:

  ```bash
  curl -s -X POST http://127.0.0.1:8001/product/search \
    -H 'Content-Type: application/json' \
    -d '{
          "query": "What fruit is rich in fiber?",
          "user_id": "tester",
          "mem_cube_id": "default_cube",
          "top_k": 5,
          "pref_top_k": 3,
          "include_preference": false
        }'
  ```

- Observed result: previously returned 400 because payload indexes (e.g., `vector_sync`) were missing in Qdrant. Index creation is now automatic during Qdrant initialization (memory_type/status/vector_sync/user_name).
- If results are empty or errors persist, verify indexes exist (auto-created on restart) or recreate/clean the collection.

### Notes / Next steps
- `/product/add` and `/product/get_all` are healthy.
- `/product/search` still returns empty results even with vectors present; likely related to search filters or vector retrieval.
- Suggested follow-ups: inspect `SearchHandler` flow, filter conditions (user_id/session/cube_name), and vector DB search calls; capture logs or compare with direct `VecDBFactory.search` calls.
