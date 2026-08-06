---
title: 性能调优
---

MemOS 的性能优化主要围绕 **记忆提取 (Mem-Reader)**、**向量嵌入 (Embedding)** 和 **检索排序 (Search Ranking)** 展开。大部分配置可以通过修改 YAML 配置文件（如 `memos_config_w_scheduler.yaml`）或直接调整源代码来实现。

## 1. 记忆提取优化 (Mem-Reader Prompt)

slow_embedder = {
    "backend": "sentence_transformer",
    "config": {
        "model_name_or_path": "nomic-ai/nomic-embed-text-v1.5"
    }
}
```
`Mem-Reader` 组件负责从对话中提取关键信息。目前的实现中，Prompt 是定义在源代码模板中的。

### 修改 Prompt 模板

要调整提取逻辑（例如忽略闲聊、专注于特定事实），你需要直接修改源码文件：

*   **文件路径**: `src/memos/templates/mem_reader_prompts.py`
*   **目标变量**: `SIMPLE_STRUCT_MEM_READER_PROMPT` (用于英文) 或 `SIMPLE_STRUCT_MEM_READER_PROMPT_ZH` (用于中文)

**示例修改**：

在 `src/memos/templates/mem_reader_prompts.py` 中：

```python
SIMPLE_STRUCT_MEM_READER_PROMPT = """
You are a preference extraction expert.
Your task is to extract ONLY user preferences and dislikes from the conversation.
Ignore all other information including plans and daily events.
...
"""
```

## 2. 向量嵌入模型优化 (Embedding Models)

Embedding 模型的选择决定了语义检索的准确性和速度。通常在 YAML 配置文件中进行设置。

### 配置文件修改

在你的配置文件（如 `memos_config.yaml`）中，找到 `mem_reader` 或 `text_mem` 下的 `embedder` 部分：

```yaml
mem_reader:
  backend: "simple_struct"
  config:
    # ... 其他配置
    embedder:
      # 方案 A: 使用 Ollama (速度快，适合本地)
      backend: "ollama"
      config:
        model_name_or_path: "nomic-embed-text:latest"

      # 方案 B: 使用 Sentence Transformer (精度高，显存占用大)
      # backend: "sentence_transformer"
      # config:
      #   model_name_or_path: "BAAI/bge-m3"
```

*   **推荐模型**:
    *   **快速/本地**: `nomic-embed-text` (Ollama)
    *   **高精度**: `BAAI/bge-m3` 或 `OpenAI` 的 `text-embedding-3-small` (需使用 `universal_api` backend)

## 3. 检索排序优化 (Search Ranking)

检索性能主要受召回数量 (`top_k`) 和重排序策略影响。

### 调整召回数量 (Top-K)

在 `mem_scheduler` 的配置中调整 `top_k`。增加此值可以提高召回率，但会增加处理时间。

```yaml
mem_scheduler:
  backend: "general_scheduler"
  config:
    # 初始检索的候选数量
    top_k: 20
    # ...
```

### 引入 Reranker (进阶)

MemOS 支持在检索后引入 Reranker 进行精排。这通常需要在初始化 `Searcher` 组件时指定。如果你是作为开发者集成 MemOS，可以在代码中配置：

```python
from memos.reranker.factory import RerankerFactory

# 在初始化 Searcher 时
reranker = RerankerFactory.from_config({
    "backend": "sentence_transformer",
    "config": {
        "model_name_or_path": "BAAI/bge-reranker-base"
    }
})
```

## 4. 系统资源与容量限制

合理限制各类记忆的容量可以防止内存无限增长，并保持检索速度。这通常在 `mem_cube` 的配置中设置。

### 内存容量配置 (Memory Size)

在 YAML 配置文件中，配置 `memory_size` 字典：

```yaml
mem_cube:
  backend: "general"
  config:
    text_mem:
      backend: "tree"
      config:
        # 限制各类记忆的条目数
        memory_size:
          WorkingMemory: 10         # 最近几轮对话的短期记忆
          LongTermMemory: 2000      # 长期记忆上限
          UserMemory: 500           # 用户画像/偏好上限
```

### 批处理与并发

在 `mem_scheduler` 中可以配置并发处理能力：

```yaml
mem_scheduler:
  config:
    thread_pool_max_workers: 10     # 并行处理线程数
    consume_interval_seconds: 0.01  # 消息队列消费间隔
    enable_parallel_dispatch: true  # 开启并行分发
```
