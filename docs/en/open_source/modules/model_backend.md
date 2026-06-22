---
title: LLMs and Embeddings
desc: "A practical guide to configuring and using Large Language Models (LLM) and Embedders in **MemOS**."
---

## Overview <a id="overview"></a>
MemOS decouples **model logic** from **runtime config** via two Pydantic factories:

| Factory | Produces | Typical backends |
|---------|----------|------------------|
| `LLMFactory` | Chat model | `ollama`, `openai`, `azure`, `qwen`, `deepseek`, `atlascloud`, `huggingface`, `huggingface_singleton`, `vllm`, `openai_new` |
| `EmbedderFactory` | Text embedder | `ollama`, `sentence_transformer`, `ark`, `universal_api` |

Both factories accept a `*_ConfigFactory.model_validate(...)` blob, so you can switch provider with a single `backend=` swap.


## LLM Module <a id="llm-module"></a>

### Supported LLM Backends <a id="supported-llm-backends"></a>
| Backend | Notes | Example model_name_or_path |
|---|---|---|
| `ollama` | Local Ollama server | `qwen3:0.6b` |
| `openai` | OpenAI-compatible Chat Completions | `gpt-4.1-nano` |
| `azure` | Azure OpenAI Chat Completions | `<your-deployment-name>` |
| `qwen` | DashScope OpenAI-compatible API | `qwen-plus` |
| `deepseek` | DeepSeek OpenAI-compatible API | `deepseek-chat` / `deepseek-reasoner` |
| `atlascloud` | Atlas Cloud OpenAI-compatible API | `deepseek-ai/DeepSeek-V3.1` |
| `huggingface` | Local transformers pipeline | `Qwen/Qwen3-1.7B` |
| `huggingface_singleton` | Same as `huggingface` + singleton reuse | `Qwen/Qwen3-1.7B` |
| `vllm` | OpenAI-compatible vLLM server | `Qwen/Qwen2.5-7B-Instruct` |
| `openai_new` | OpenAI Responses API wrapper | `gpt-4.1` |

### LLM Config Schema <a id="llm-config-schema"></a>


Common fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model_name_or_path` | str | – | Model id or local tag |
| `temperature` | float | 0.7 |
| `max_tokens` | int | 8192 |
| `top_p` / `top_k` | float / int | 0.95 / 50 |
| *API‑specific* | e.g. `api_key`, `api_base` | – | OpenAI‑compatible creds |
| `remove_think_prefix` | bool | False | Remove content within think tags from the generated text |


### Factory Usage <a id="llm-factory-usage"></a>
```python
from memos.configs.llm import LLMConfigFactory
from memos.llms.factory import LLMFactory

cfg = LLMConfigFactory.model_validate({
    "backend": "ollama",
    "config": {"model_name_or_path": "qwen3:0.6b"}
})
llm = LLMFactory.from_config(cfg)
```

### LLM Core APIs <a id="llm-core-apis"></a>
| Method | Purpose |
|--------|---------|
| `generate(messages: list)` | Return full string response |
| `generate_stream(messages)` | Yield streaming chunks|

### Streaming & CoT <a id="streaming--cot"></a>
```python
messages = [{"role": "user", "content": "Let’s think step by step: …"}]
for chunk in llm.generate_stream(messages):
    print(chunk, end="")
```

::note
**Full code**
Find all scenarios in `examples/basic_modules/llm.py`.
::

### Performance Tips <a id="llm-performance-tips"></a>
- Use `qwen3:0.6b` for <2 GB footprint when prototyping locally.
- Combine with KV Cache (see *KVCacheMemory* doc) to cut TTFT .

## Embedding Module <a id="embedding-module"></a>

### Supported Embedder Backends <a id="supported-embedder-backends"></a>
| Backend | Notes | Example model_name_or_path |
|---|---|---|
| `ollama` | Local Ollama server | `nomic-embed-text:latest` |
| `sentence_transformer` | Local sentence-transformers | `nomic-ai/nomic-embed-text-v1.5` |
| `ark` | Volcano Engine Ark embeddings | `<ark-model-id>` |
| `universal_api` | Universal provider wrapper (e.g. OpenAI) | `text-embedding-3-large` |

### Embedder Config Schema <a id="embedder-config-schema"></a>
Shared keys: `model_name_or_path`, optional API creds (`api_key`, `base_url`), etc.

### Factory Usage <a id="embedder-factory-usage"></a>
```python
from memos.configs.embedder import EmbedderConfigFactory
from memos.embedders.factory import EmbedderFactory

cfg = EmbedderConfigFactory.model_validate({
    "backend": "ollama",
    "config": {"model_name_or_path": "nomic-embed-text:latest"}
})
embedder = EmbedderFactory.from_config(cfg)
```
