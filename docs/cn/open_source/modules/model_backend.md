---
title: LLMs 与 Embedding
desc: "在 **MemOS** 中配置和使用大语言模型（LLM）与 Embedder 的实用指南。"
---

## 概述 <a id="overview"></a>
MemOS 通过两个 Pydantic 工厂将 **模型逻辑** 与 **运行时配置** 解耦：

| 工厂 | 产物 | 常见后端 |
|---------|----------|------------------|
| `LLMFactory` | 对话模型 | `ollama`、`openai`、`azure`、`qwen`、`deepseek`、`huggingface`、`huggingface_singleton`、`vllm`、`openai_new` |
| `EmbedderFactory` | 文本 Embedder | `ollama`、`sentence_transformer`、`ark`、`universal_api` |

两个工厂都接收 `*_ConfigFactory.model_validate(...)` 的配置字典，因此你只需修改 `backend=` 一项即可切换提供方。


## LLM 模块 <a id="llm-module"></a>

### 支持的 LLM 后端 <a id="supported-llm-backends"></a>
| 后端 | 说明 | 示例 model_name_or_path |
|---|---|---|
| `ollama` | 本地 Ollama 服务 | `qwen3:0.6b` |
| `openai` | OpenAI 兼容的 Chat Completions | `gpt-4.1-nano` |
| `azure` | Azure OpenAI Chat Completions | `<your-deployment-name>` |
| `qwen` | DashScope OpenAI 兼容 API | `qwen-plus` |
| `deepseek` | DeepSeek OpenAI 兼容 API | `deepseek-chat` / `deepseek-reasoner` |
| `huggingface` | 本地 transformers pipeline | `Qwen/Qwen3-1.7B` |
| `huggingface_singleton` | 与 `huggingface` 相同，并支持单例复用 | `Qwen/Qwen3-1.7B` |
| `vllm` | OpenAI 兼容的 vLLM 服务 | `Qwen/Qwen2.5-7B-Instruct` |
| `openai_new` | OpenAI Responses API 封装 | `gpt-4.1` |

### LLM 配置 Schema <a id="llm-config-schema"></a>


通用字段：

| 字段 | 类型 | 默认值 | 说明 |
|-------|------|---------|-------------|
| `model_name_or_path` | str | – | 模型 ID 或本地标签 |
| `temperature` | float | 0.7 |
| `max_tokens` | int | 8192 |
| `top_p` / `top_k` | float / int | 0.95 / 50 |
| *API 专属* | 例如 `api_key`、`api_base` | – | OpenAI 兼容的凭证 |
| `remove_think_prefix` | bool | False | 从生成文本中去除 think 标签内的内容 |


### 工厂用法 <a id="llm-factory-usage"></a>
```python
from memos.configs.llm import LLMConfigFactory
from memos.llms.factory import LLMFactory

cfg = LLMConfigFactory.model_validate({
    "backend": "ollama",
    "config": {"model_name_or_path": "qwen3:0.6b"}
})
llm = LLMFactory.from_config(cfg)
```

### LLM 核心 API <a id="llm-core-apis"></a>
| 方法 | 用途 |
|--------|---------|
| `generate(messages: list)` | 返回完整字符串响应 |
| `generate_stream(messages)` | 以流式方式逐块产出响应 |

### 流式输出与 CoT <a id="streaming--cot"></a>
```python
messages = [{"role": "user", "content": "Let’s think step by step: …"}]
for chunk in llm.generate_stream(messages):
    print(chunk, end="")
```

::note
**完整代码**
所有场景的示例参见 `examples/basic_modules/llm.py`。
::

### 性能建议 <a id="llm-performance-tips"></a>
- 本地原型阶段可使用 `qwen3:0.6b`，占用 <2 GB。
- 配合 KV Cache（参见 *KVCacheMemory* 文档）可降低 TTFT。

## Embedding 模块 <a id="embedding-module"></a>

### 支持的 Embedder 后端 <a id="supported-embedder-backends"></a>
| 后端 | 说明 | 示例 model_name_or_path |
|---|---|---|
| `ollama` | 本地 Ollama 服务 | `nomic-embed-text:latest` |
| `sentence_transformer` | 本地 sentence-transformers | `nomic-ai/nomic-embed-text-v1.5` |
| `ark` | 火山引擎 Ark embeddings | `<ark-model-id>` |
| `universal_api` | 通用提供方封装（例如 OpenAI） | `text-embedding-3-large` |

### Embedder 配置 Schema <a id="embedder-config-schema"></a>
共有字段：`model_name_or_path`，可选的 API 凭证（`api_key`、`base_url`）等。

### 工厂用法 <a id="embedder-factory-usage"></a>
```python
from memos.configs.embedder import EmbedderConfigFactory
from memos.embedders.factory import EmbedderFactory

cfg = EmbedderConfigFactory.model_validate({
    "backend": "ollama",
    "config": {"model_name_or_path": "nomic-embed-text:latest"}
})
embedder = EmbedderFactory.from_config(cfg)
```
