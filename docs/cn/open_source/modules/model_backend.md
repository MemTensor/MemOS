---
title: LLMs and Embeddings
desc: "在 **MemOS** 中配置和使用大型语言模型（LLM）及嵌入器的实用指南。"
---

## 概述 <a id="overview"></a>
MemOS 通过两个 Pydantic 工厂类将**模型逻辑**与**运行时配置**解耦：

| 工厂类 | 产出 | 典型后端 |
|---------|----------|------------------|
| `LLMFactory` | 对话模型 | `ollama`, `openai`, `azure`, `qwen`, `deepseek`, `huggingface`, `huggingface_singleton`, `vllm`, `openai_new` |
| `EmbedderFactory` | 文本嵌入器 | `ollama`, `sentence_transformer`, `ark`, `universal_api` |

两个工厂类均接受 `*_ConfigFactory.model_validate(...)` 配置对象，因此只需修改 `backend=` 参数即可切换服务提供商。


## LLM 模块 <a id="llm-module"></a>

### 支持的 LLM 后端 <a id="supported-llm-backends"></a>
| Backend | 说明 | 示例 model_name_or_path |
|---|---|---|
| `ollama` | 本地 Ollama 服务器 | `qwen3:0.6b` |
| `openai` | 兼容 OpenAI 的 Chat Completions 接口 | `gpt-4.1-nano` |
| `azure` | Azure OpenAI Chat Completions | `<your-deployment-name>` |
| `qwen` | DashScope 兼容 OpenAI 的 API | `qwen-plus` |
| `deepseek` | DeepSeek 兼容 OpenAI 的 API | `deepseek-chat` / `deepseek-reasoner` |
| `huggingface` | 本地 transformers pipeline | `Qwen/Qwen3-1.7B` |
| `huggingface_singleton` | 与 `huggingface` 相同，但启用单例复用 | `Qwen/Qwen3-1.7B` |
| `vllm` | 兼容 OpenAI 的 vLLM 服务器 | `Qwen/Qwen2.5-7B-Instruct` |
| `openai_new` | OpenAI Responses API 封装 | `gpt-4.1` |

### LLM 配置模式 <a id="llm-config-schema"></a>


常用字段：

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `model_name_or_path` | str | – | 模型 ID 或本地标签 |
| `temperature` | float | 0.7 | |
| `max_tokens` | int | 8192 | |
| `top_p` / `top_k` | float / int | 0.95 / 50 | |
| *API 专用字段* | 如 `api_key`, `api_base` | – | 兼容 OpenAI 的认证信息 |
| `remove_think_prefix` | bool | False | 从生成文本中移除思考标签内的内容 |


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
| `generate(messages: list)` | 返回完整的字符串响应 |
| `generate_stream(messages)` | 以流式方式逐块生成内容 |

### 流式输出与思维链（CoT） <a id="streaming--cot"></a>
```python
messages = [{"role": "user", "content": "Let's think step by step: …"}]
for chunk in llm.generate_stream(messages):
    print(chunk, end="")
```

::note
**完整代码**
所有使用场景示例请参见 `examples/basic_modules/llm.py`。
::

### 性能建议 <a id="llm-performance-tips"></a>
- 在本地原型开发时，使用 `qwen3:0.6b` 可将内存占用控制在 2 GB 以内。
- 结合 KV Cache（参见 *KVCacheMemory* 文档）可降低首个 token 的生成延迟（TTFT）。

## 嵌入模块 <a id="embedding-module"></a>

### 支持的嵌入器后端 <a id="supported-embedder-backends"></a>
| Backend | 说明 | 示例 model_name_or_path |
|---|---|---|
| `ollama` | 本地 Ollama 服务器 | `nomic-embed-text:latest` |
| `sentence_transformer` | 本地 sentence-transformers | `nomic-ai/nomic-embed-text-v1.5` |
| `ark` | 火山引擎 Ark 嵌入服务 | `<ark-model-id>` |
| `universal_api` | 通用服务提供商封装（如 OpenAI） | `text-embedding-3-large` |

### 嵌入器配置模式 <a id="embedder-config-schema"></a>
共享字段：`model_name_or_path`，可选的 API 认证信息（`api_key`、`base_url`）等。

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
