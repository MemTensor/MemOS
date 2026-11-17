# Pipeline Hook Reference

Use this reference when implementing a plugin that observes or modifies MemOS
search, extraction, or memory operations. For plugin registration and lifecycle,
start with the [plugin guide](README.md#using-hooks).

Hook names and keyword parameters are declared in [hook_defs.py](hook_defs.py).
The runtime lives in [hooks.py](hooks.py).

---

## How hooks work

Every hook falls into one of three patterns:

| Pattern | Return value matters? | API | Exception handling |
| --- | --- | --- | --- |
| **Pipeline hook** — has a `pipe_key` | Yes — non-`None` replaces that argument for subsequent callbacks | `trigger_hook` | Logged and swallowed; later callbacks still run |
| **Observer hook** — no `pipe_key` | No | `trigger_hook` | Logged and swallowed |
| **Single-provider hook** | Returned directly to caller | `trigger_single_hook` | Re-raised |

---

## Registering callbacks

- Call `self.register_hook(H.NAME, callback)` **once** per plugin lifecycle. Registration is
  additive — calling it twice registers the callback twice.
- Callbacks run synchronously, in registration order. `@hookable`-decorated handlers support
  async, but hook callbacks themselves are not awaited.
- Accept `**kwargs` in any callback to stay forward-compatible when a hook gains new arguments.

---

## Pipeline callbacks (`pipe_key` present)

The `pipe_key` column tells you which argument a return value replaces:

- **Return a non-`None` value** → replaces that argument for all later callbacks and the caller.
- **Return `None`** → keeps the current value unchanged.
- `False`, `[]`, `{}`, and `0` are all **replacements** — only `None` means "pass-through".

Because arguments are live objects, in-place mutations are visible to later callbacks even when
your callback returns `None`. Return a copy when isolation is needed, and preserve the shape
downstream code expects.

---

## HookContext

Context-aware hooks receive `hook_context` alongside their business arguments.
It carries correlation metadata, not the request, result, or exception payload.

| Field | Meaning |
| --- | --- |
| `trace_id` | Trace identifier available at the operation boundary. |
| `user_id` | User identifier from the request, reader input, or scheduler message. |
| `session_id` | Session identifier when available. Search uses `default_session` when omitted. |
| `task_id` | Task identifier when available. |
| `cube_ids` | Tuple of relevant cube identifiers; empty when unavailable. |
| `operation_id` | UUID hex string identifying one observed operation. |
| `source` | Integration point that created the context; see the tables below. |
| `attributes` | Integration-specific metadata such as mode or scheduler item ID. |

Fields unavailable at a boundary are `None`. Treat the context as read-only — the
dataclass is frozen, but `attributes` is not deeply immutable. The builder copies the
outer attributes mapping and converts cube IDs to a tuple.

### Receiving `hook_context` in your callback

Declare `hook_context` as a keyword parameter, or pull it from `**kwargs`:

```python
# Option A — explicit parameter
def my_callback(self, results, hook_context, **kwargs):
    print(hook_context.trace_id)

# Option B — via kwargs (useful when the same handler is registered on hooks
# both with and without context)
def my_callback(self, results, **kwargs):
    ctx = kwargs.get("hook_context")  # None if hook does not provide it
```

The runtime omits `hook_context` when the callback's signature accepts neither form.
Hooks that do **not** provide context will never pass it, even if you declare the parameter.

For `@hookable(..., context_builder=...)`, an explicit non-`None` context is reused,
including when passed positionally to the decorated method. An omitted or `None`
context is built automatically. Methods that do not accept `hook_context` receive
only their business arguments; their hooks still receive the context.

### Context scope

- **Search** builds a context for `search.before` and `search.after`. Each intermediate
  hook creates its own context.
- **Reader extraction**, **cube writes**, and **scheduler operations** each create a separate
  context. Use `trace_id` or `task_id` for
  broader correlation.

---

## Search pipeline

The successful `SearchHandler.handle_search_memories` path is:

```text
search.before
  └─► retrieval
      └─► search.memory_results
          └─► threshold filtering ──► search.results.after_threshold
              └─► deduplication   ──► search.results.after_dedup
                  └─► reranking   ──► search.results.after_rerank
                      └─► search.context.render
                          └─► SearchResponse construction
                              └─► search.after
```

| Constant / Hook name | Additional arguments | `pipe_key` | Typical use |
| --- | --- | --- | --- |
| `H.SEARCH_BEFORE` / `search.before` | `request` | `request` | Rewrite the query or inject filters before retrieval. |
| `H.SEARCH_MEMORY_RESULTS` / `search.memory_results` | `handler`, `search_req`, `results` | `results` | Inspect or augment raw retrieval output. |
| `H.SEARCH_RESULTS_AFTER_THRESHOLD` / `search.results.after_threshold` | `handler`, `search_req`, `results` | `results` | Remove or re-score results after score filtering. |
| `H.SEARCH_RESULTS_AFTER_DEDUP` / `search.results.after_dedup` | `handler`, `search_req`, `results` | `results` | Post-dedup cleanup; runs even when no dedup mode is selected. |
| `H.SEARCH_RESULTS_AFTER_RERANK` / `search.results.after_rerank` | `handler`, `search_req`, `results` | `results` | Apply a custom final ranking. |
| `H.SEARCH_CONTEXT_RENDER` / `search.context.render` | `handler`, `search_req`, `results` | `results` | Last chance to modify the result dictionary before response construction. |
| `H.SEARCH_AFTER` / `search.after` | `request`, `result` | `result` | Post-process or log the final `SearchResponse`. |
| `H.SEARCH_POST_PROCESS_FAILED` / `search.post_process.failed` | `handler`, `search_req`, `error` | — | Observe an exception escaping threshold/dedup/reranking. |

**Argument notes:**
- `request` at `search.before` and `search.after` is an `APISearchRequest`. The `search.after`
  hook receives the request *after* any `search.before` replacement.
- Intermediate hooks receive `search_req` (the handler's working copy, which may include
  internal adjustments such as expanded `top_k` for deduplication) and `results` (the
  result-bucket dictionary). When returning a replacement, preserve its required buckets and
  item structures.

---

## MemReader extraction

These hooks wrap `SimpleStructMemReader.get_memory`, including subclasses that inherit
that implementation.

```text
get_memory()
  └─► validation + input coercion + _read_memory()
      ├─► [success] mem_reader.extract.after
      └─► [failure] mem_reader.extract.failed  ──► exception re-raised
```

Both hooks receive `hook_context`, `mem_reader`, `scene_data`, `type`, `info`, `mode`,
`user_name`, and `kwargs`.

| Constant / Hook name | Additional argument | Timing | `pipe_key` |
| --- | --- | --- | --- |
| `H.MEM_READER_EXTRACT_AFTER` / `mem_reader.extract.after` | `result` | After validation, input coercion, and `_read_memory` return successfully. | `result` |
| `H.MEM_READER_EXTRACT_FAILED` / `mem_reader.extract.failed` | `error` | When validation, input coercion, or `_read_memory` raises an exception. | — |

- `scene_data` is the raw input passed to `get_memory`, before coercion.
- `kwargs` is the dictionary of extra reader arguments.
- `result` has the shape `list[list[TextualMemoryItem]]`.
- The failure hook observes the original exception, which is then re-raised.

Context: source `mem_reader.extract`; user/session IDs from `info`; cube IDs from
`user_name` when supplied; attributes contain `mode` and `type`.

---

## Textual memory writes

These hooks surround the `text_memory.add` call in `SingleCubeView._process_text_mem`.

```text
_process_text_mem()
  └─► text_memory.add(memories, user_name=...)
      ├─► [success] text_memory.add.after
      └─► [failure] text_memory.add.failed  ──► exception re-raised
```

Both hooks receive `hook_context`, `text_memory`, `memories`, and `kwargs`.
- `memories` is the group submitted to the backend, excluding `RawFileMemory` items.
- `kwargs` contains the `user_name` for the write.

| Constant / Hook name | Additional argument | Timing | `pipe_key` |
| --- | --- | --- | --- |
| `H.TEXT_MEMORY_ADD_AFTER` / `text_memory.add.after` | `result` | After the backend add call returns. | `result` |
| `H.TEXT_MEMORY_ADD_FAILED` / `text_memory.add.failed` | `error` | When the backend add call raises an exception. | — |

- The success `result` is a list of stored memory IDs. A replacement is consumed by subsequent
  processing, including scheduling and response construction — keep IDs consistent with the
  stored memories.
- Backend exceptions are re-raised after observation.

Context: source `cube_view.text_mem.add`; attributes contain `sync_mode` and `extract_mode`;
user, session, task, and cube metadata come from the add operation.

---

## Scheduler memory operations

`MemReadMessageHandler` observes selected operations through `SchedulerOperationObserver`.
Both hooks receive `hook_context`, `operation`, and `operation_input`.

```text
SchedulerOperationObserver
  └─► operation (fine | add | delete | soft_delete)
      ├─► [success] scheduler.memory.operation.after
      └─► [failure] scheduler.memory.operation.failed
```

| Constant / Hook name | Additional argument | `pipe_key` |
| --- | --- | --- |
| `H.SCHEDULER_MEMORY_OPERATION_AFTER` / `scheduler.memory.operation.after` | `result` | `result` |
| `H.SCHEDULER_MEMORY_OPERATION_FAILED` / `scheduler.memory.operation.failed` | `error` | — |

Context source has the prefix `scheduler.mem_read.` followed by the operation suffix below.

| `operation` | Source suffix | `operation_input` keys | Successful result | Notes |
| --- | --- | --- | --- | --- |
| `fine` | `fine_transfer_simple_mem` | `memories`, `type`, `custom_tags`, `user_name`, `chat_history`, `user_context`, `is_upload_skill`, `result_grouping` | Nested reader output; replacements consumed before flattening and storage. | See [Fine-transfer result grouping](#fine-transfer-result-grouping). |
| `add` | `add_enhanced_memories` | `memories`, `user_name` | Stored IDs; replacements consumed by subsequent processing. | |
| `delete` | `remove_memories` | `memory_ids`, `user_name` | Backend delete return value; handler does not consume a replacement. | |
| `soft_delete` | `remove_memories` | `memory_ids`, `user_name`, `preserved_memory_ids` | Backend soft-delete return value; handler does not consume a replacement. | |

The observer emits a success hook only after the operation block exits successfully — a
recorded `None` is still a successful result. Failure is reported at most once per observer.
These operations run only when the corresponding handler branch executes.

### Fine-transfer result grouping

Check `operation_input["result_grouping"]` on `fine` operations before matching output
groups to input memories:

| Value | Interpretation |
| --- | --- |
| `per_input` | One group per input, in input order (built-in `SimpleStructMemReader`). A worker exception or `None` result leaves an empty group at that position. Empty input → `[]`. |
| `batch` | One group for the entire batch (built-in `MultiModalStructMemReader`). Not one-to-one with inputs — **do not zip**. Empty input → `[]`. |
| `unknown` | Implementation not recognized (e.g. a method override). Do not assume positional correspondence. |

The label describes the reader's contract, not your plugin's replacement. Preserve the
original grouping in a replacement so downstream callbacks can interpret it consistently.

Inheriting a recognized built-in method preserves its grouping label. An override receives
`unknown`, even if it belongs to a subclass of a built-in reader.
