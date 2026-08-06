---
title: "KVCacheMemory: Key-Value Cache for Activation Memory"
desc: "`KVCacheMemory` is a specialized memory module in MemOS for storing and managing key-value (KV) caches, primarily used to accelerate large language model (LLM) inference and support efficient context reuse. It is especially useful for activation memory in conversational and generative AI systems."
---

## KV-cache Memory Use Cases

In MemOS, KV-cache memory is best suited for storing **semantically stable and frequently reused background content** such as:

- Frequently asked questions (FAQs) or domain-specific knowledge
- Prior conversation history

These stable **plaintext memory items** are automatically identified and managed by the `MemScheduler` module. Once selected, they are converted into KV-format representations (`KVCacheItem`) ahead of time. This precomputation step stores the activation states (Key/Value tensors) of the memory in a reusable format, allowing them to be injected into the model’s attention cache during inference.

Once converted, these KV memories can be **reused across queries without requiring re-encoding** of the original content. This reduces the computational overhead of processing and storing large amounts of text, making it ideal for applications that require **rapid response times** and **high throughput**.


## Why KV-cache Memory
Integrating `MemScheduler` with KV-cache memory enables significant performance optimization, particularly in the **prefill phase** of LLM inference.

### Without KVCacheMemory

- Each new query is appended to the full prompt, including the background memory.
- The model must **recompute token embeddings and attention** over the full sequence — even for unchanged memory.

### With KVCacheMemory

- The background content is **cached once** as Key/Value tensors.
- For each query, only the new user input (query tokens) is encoded.
- The previously cached KV is injected directly into the attention mechanism.

### Benefits

This separation reduces redundant computation in the prefill phase and leads to:

- Skipping repeated encoding of background content
- Faster attention computation between query tokens and cached memory
- **Lower Time To First Token (TTFT)** latency during generation

This optimization is especially valuable in:

- Multi-turn chatbot interactions
- Retrieval-augmented or context-augmented generation (RAG, CAG)
- Assistants operating over fixed documentation or FAQ-style memory


### KVCacheMemory Acceleration Evaluation

To validate the performance impact of KV-based memory injection, we conducted a set of controlled experiments simulating real memory reuse in MemOS.

#### Experiment Setup

During typical usage, the `MemScheduler` module continuously tracks interaction patterns and promotes high-frequency, stable plaintext memory into KV format. These KV memories are loaded into GPU memory as activation caches and reused during inference.

The evaluation compares two memory injection strategies:

1. **Prompt-based injection**: background memory is prepended as raw text.
2. **KV-cache injection**: memory is injected directly into the model’s attention cache.

We test these strategies across:

- **Three context sizes**: short, medium, and long
- **Three query types**: short-form, medium-form, and long-form

The primary metric is **Time To First Token (TTFT)**, a key latency indicator for responsive generation.

#### Results

The following table shows results across three models (Qwen3-8B, Qwen3-32B, Qwen2.5-72B). TTFT under KV-cache injection is consistently lower than prompt-based injection, while the output tokens remain identical across both strategies.

::note{icon="ri:bnb-fill"}
`Build (s)` refers to the one-time preprocessing cost of converting the memory to KV format, amortized across multiple queries.
::

| Model       | Ctx    | CtxTok | Qry    | QryTok | Build (s) | KV TTFT (s) | Dir TTFT (s) | Speedup (%) |
| ----------- | ------ | ------ | ------ | ------ | --------- | ----------- | ------------ | ----------- |
| Qwen3-8B    | long   | 6064   | long   | 952.7  | 0.92      | 0.50        | 2.37         | 79.1        |
|             |        |        | medium | 302.7  | 0.93      | 0.19        | 2.16         | 91.1        |
|             |        |        | short  | 167    | 0.93      | 0.12        | 2.04         | 94.2        |
|             | medium | 2773   | long   | 952.7  | 0.41      | 0.43        | 1.22         | 64.6        |
|             |        |        | medium | 302.7  | 0.41      | 0.16        | 1.08         | 85.1        |
|             |        |        | short  | 167    | 0.43      | 0.10        | 0.95         | 89.7        |
|             | short  | 583    | long   | 952.7  | 0.12      | 0.39        | 0.51         | 23.0        |
|             |        |        | medium | 302.7  | 0.12      | 0.14        | 0.32         | 55.6        |
|             |        |        | short  | 167    | 0.12      | 0.08        | 0.29         | 71.3        |
| Qwen3-32B   | long   | 6064   | long   | 952.7  | 0.71      | 0.31        | 1.09         | 71.4        |
|             |        |        | medium | 302.7  | 0.71      | 0.15        | 0.98         | 84.3        |
|             |        |        | short  | 167    | 0.71      | 0.11        | 0.96         | 88.8        |
|             | medium | 2773   | long   | 952.7  | 0.31      | 0.24        | 0.56         | 56.9        |
|             |        |        | medium | 302.7  | 0.31      | 0.12        | 0.47         | 75.1        |
|             |        |        | short  | 167    | 0.31      | 0.08        | 0.44         | 81.2        |
|             | short  | 583    | long   | 952.7  | 0.09      | 0.20        | 0.24         | 18.6        |
|             |        |        | medium | 302.7  | 0.09      | 0.09        | 0.15         | 39.6        |
|             |        |        | short  | 167    | 0.09      | 0.07        | 0.14         | 53.5        |
| Qwen2.5-72B | long   | 6064   | long   | 952.7  | 1.26      | 0.48        | 2.04         | 76.4        |
|             |        |        | medium | 302.7  | 1.26      | 0.23        | 1.82         | 87.2        |
|             |        |        | short  | 167    | 1.27      | 0.15        | 1.79         | 91.4        |
|             | medium | 2773   | long   | 952.7  | 0.58      | 0.39        | 1.05         | 62.7        |
|             |        |        | medium | 302.7  | 0.58      | 0.18        | 0.89         | 79.2        |
|             |        |        | short  | 167    | 0.71      | 0.23        | 0.82         | 71.6        |
|             | short  | 583    | long   | 952.7  | 0.16      | 0.33        | 0.43         | 23.8        |
|             |        |        | medium | 302.7  | 0.16      | 0.15        | 0.27         | 43.2        |
|             |        |        | short  | 167    | 0.16      | 0.10        | 0.25         | 60.5        |

#### vLLM-based Performance

MemOS now supports using vLLM to manage activation memory. To evaluate the impact of KV Cache prefilling for different prefix text lengths, we conducted performance tests on a system equipped with 8x `H800 80GB GPUs (112 vCPUs, 1920 GiB Memory)` and a system equipped with 8x `RTX4090-24G-PCIe (112 vCPUs, 960 GiB Memory)`. The evaluation covered two core models: Qwen3-32B and Qwen2.5-72B.

The benchmarks were run across a range of memory and context length combinations to simulate various activation memory scenarios:
- **Memory Text Lengths (tokens)**: 500, 1000, 2000
- **Context Text Lengths (tokens)**: 500, 1000, 2000, 4000

The following table summarizes the benchmark results.

**Qwen2.5-72B**
- On 4090 (2 Nodes 16 GPUs)

| mem tks | prompt tks | TTFT (without cache, ms) | TTFT (With cache, ms) | TTFT Speedup (%) | Abs Dis(ms) |
| --- | --- | --- | --- | --- | --- |
| 0.5k | 0.5k | 1787.21 | 851.47 | 52.358% | 935.74 |
| 0.5k | 1k | 2506.26 | 1290.68 | 48.502% | 1215.58 |
| 0.5k | 2k | 3843.48 | 2897.97 | 24.600% | 945.51 |
| 0.5k | 4k | 6078.01 | 5200.86 | 14.432% | 877.15 |
| 1k | 0.5k | 2274.61 | 920.16 | 59.546% | 1354.45 |
| 1k | 1k | 2907.17 | 1407.65 | 51.580% | 1499.52 |
| 1k | 2k | 4278.53 | 2916.47 | 31.835% | 1362.06 |
| 1k | 4k | 6897.99 | 5218.94 | 24.341% | 1679.05 |
| 2k | 0.5k | 3460.12 | 782.73 | 77.379% | 2677.39 |
| 2k | 1k | 4443.34 | 1491.24 | 66.439% | 2952.10 |
| 2k | 2k | 5733.14 | 2758.48 | 51.885% | 2974.66 |
| 2k | 4k | 8152.76 | 5627.41 | 30.975% | 2525.35 |


- On H800 (4 GPUs)

| mem tks | prompt tks | TTFT (without cache, ms) | TTFT (With cache, ms) | TTFT Speedup (%) | Abs Dis(ms) |
| --- | --- | --- | --- | --- | --- |
| 0.5k | 0.5k | 51.65 | 52.17 | \-1.007% | \-0.52 |
| 0.5k | 1k | 55.70 | 57.03 | \-2.388% | \-1.33 |
| 0.5k | 2k | 74.23 | 78.56 | \-5.833% | \-4.33 |
| 0.5k | 4k | 77.56 | 77.45 | 0.142% | 0.11 |
| 1k | 0.5k | 55.90 | 55.73 | 0.304% | 0.17 |
| 1k | 1k | 55.35 | 52.89 | 4.444% | 2.46 |
| 1k | 2k | 80.14 | 73.82 | 7.886% | 6.32 |
| 1k | 4k | 82.83 | 73.51 | 11.252% | 9.32 |
| 2k | 0.5k | 75.82 | 71.31 | 5.948% | 4.51 |
| 2k | 1k | 80.60 | 78.71 | 2.345% | 1.89 |
| 2k | 2k | 83.91 | 78.60 | 6.328% | 5.31 |
| 2k | 4k | 99.15 | 80.12 | 19.193% | 19.03 |

**Qwen3-32B**

- On 4090 (1 Nodes 8 GPUs)

| mem tks | prompt tks | TTFT (without cache, ms) | TTFT (With cache, ms) | TTFT Speedup (%) | Abs Dis(ms) |
| --- | --- | --- | --- | --- | --- |
| 0.5k | 0.5k | 288.72 | 139.29 | 51.756% | 149.43 |
| 0.5k | 1k | 428.72 | 245.85 | 42.655% | 182.87 |
| 0.5k | 2k | 683.65 | 538.59 | 21.218% | 145.06 |
| 0.5k | 4k | 1170.48 | 986.94 | 15.681% | 183.54 |
| 1k | 0.5k | 409.83 | 137.96 | 66.337% | 271.87 |
| 1k | 1k | 507.95 | 262.21 | 48.379% | 245.74 |
| 1k | 2k | 743.48 | 539.71 | 27.408% | 203.77 |
| 1k | 4k | 1325.34 | 1038.59 | 21.636% | 286.75 |
| 2k | 0.5k | 686.01 | 147.34 | 78.522% | 538.67 |
| 2k | 1k | 762.96 | 246.22 | 67.728% | 516.74 |
| 2k | 2k | 1083.93 | 498.05 | 54.051% | 585.88 |
| 2k | 4k | 1435.39 | 1053.31 | 26.619% | 382.08 |


- On H800 (2 GPUs)

| mem tks | prompt tks | TTFT (without cache, ms) | TTFT (With cache, ms) | TTFT Speedup (%) | Abs Dis(ms) |
| --- | --- | --- | --- | --- | --- |
| 0.5k | 0.5k | 161.18 | 97.61 | 39.440% | 63.57 |
| 0.5k | 1k | 164.00 | 121.39 | 25.982% | 42.61 |
| 0.5k | 2k | 257.34 | 215.20 | 16.375% | 42.14 |
| 0.5k | 4k | 365.14 | 317.95 | 12.924% | 47.19 |
| 1k | 0.5k | 169.45 | 100.52 | 40.679% | 68.93 |
| 1k | 1k | 180.91 | 128.25 | 29.108% | 52.66 |
| 1k | 2k | 271.69 | 210.00 | 22.706% | 61.69 |
| 1k | 4k | 389.30 | 314.64 | 19.178% | 74.66 |
| 2k | 0.5k | 251.43 | 130.92 | 47.930% | 120.51 |
| 2k | 1k | 275.81 | 159.60 | 42.134% | 116.21 |
| 2k | 2k | 331.11 | 218.17 | 34.110% | 112.94 |
| 2k | 4k | 451.06 | 334.80 | 25.775% | 116.26 |

The results clearly demonstrate that integrating vLLM's KV Cache reuse provides a transformative performance improvement for MemOS.

## KV-cache Memory Structure

KV-based memory reuse via `KVCacheMemory` offers substantial latency reduction across model sizes and query types, while maintaining identical output. By shifting reusable memory from plaintext prompts into precomputed KV caches, MemOS eliminates redundant context encoding and achieves faster response times—especially beneficial in real-time, memory-augmented LLM applications.

Each cache is stored as a `KVCacheItem`:

| Field         | Type           | Description                                 |
| ------------- | -------------- | ------------------------------------------- |
| `kv_cache_id` | `str`          | Unique ID for the cache (UUID)              |
| `kv_cache`    | `DynamicCache` | The actual key-value cache (transformers)   |
| `metadata`    | `dict`         | Metadata (source, extraction time, etc.)    |


## API Summary (`KVCacheMemory`)

### Initialization
```python
KVCacheMemory(config: KVCacheMemoryConfig)
```

### Core Methods
| Method                   | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `extract(text)`          | Extracts a KV cache from input text using the LLM        |
| `add(memories)`          | Adds one or more `KVCacheItem` to memory                 |
| `get(memory_id)`         | Fetch a single cache by ID                               |
| `get_by_ids(ids)`        | Fetch multiple caches by IDs                             |
| `get_all()`              | Returns all stored caches                                |
| `get_cache(cache_ids)`   | Merge and return a combined cache from multiple IDs      |
| `delete(ids)`            | Delete caches by IDs                                     |
| `delete_all()`           | Delete all caches                                        |
| `dump(dir)`              | Serialize all caches to a pickle file in directory       |
| `load(dir)`              | Load caches from a pickle file in directory              |
| `from_textual_memory(mem)` | Convert a `TextualMemoryItem` to a `KVCacheItem`      |
| `build_vllm_kv_cache( messages)` | Build a vLLM KV cache from a list of messages   |


When calling `dump(dir)`, the system writes to:

```
<dir>/<config.memory_filename>
```

This file contains a pickled dictionary of all KV caches, which can be reloaded using `load(dir)`.


## How to Use

```python
from memos.configs.memory import KVCacheMemoryConfig
from memos.memories.activation.kv import KVCacheMemory

config = KVCacheMemoryConfig(
    extractor_llm={
        "backend": "huggingface",
        "config": {"model_name_or_path": "Qwen/Qwen3-1.7B"}
    }
)
mem = KVCacheMemory(config)

# Extract and add a cache
cache_item = mem.extract("The capital of France is Paris.")
mem.add([cache_item])

# Retrieve and merge caches
merged_cache = mem.get_cache([cache_item.kv_cache_id])

# Save/load
mem.dump("tmp/act_mem")
mem.load("tmp/act_mem")
```


## Developer Notes

* Uses HuggingFace `DynamicCache` for efficient key-value storage
* Pickle-based serialization for fast load/save
* All methods are covered by integration tests in `/tests`
