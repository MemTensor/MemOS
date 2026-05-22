---
title: "KVCacheMemory: 激活记忆"
desc: "`KVCacheMemory` 是MemOS中用于存储和管理KV cache的专用记忆模块，主要用于加速大语言模型（LLMs）推理并支持有效的上下文复用。作为激活记忆，它有助于提升会话式和生成式人工智能系统的性能。"
---

## KV Cache记忆使用案例

在MemOS中，KV Cache最适合存储**语义稳定且经常复用的背景信息**，例如：
- 常见问题（FAQs）或特定领域知识
- 先前的对话历史

这些稳定的**明文记忆项**由`MemScheduler`模块自动识别和管理。一旦被选中，它们就会被提前转换成KV格式的表示(`KVCacheItem`)。这个预计算步骤以可复用的格式存储记忆的激活状态（键值对张量），允许它们在推理期间注入到模型的注意力缓存中。

一旦进行转换，这些KV记忆就可以**跨查询复用**，而不需要对原始内容重新编码。这减少了处理和存储大量文本的计算开销，使其成为需要**快速响应时间**和**高吞吐量**的应用程序的理想选择。

## 为什么是KV Cache记忆
将`MemScheduler`与KV Cache记忆集成可以实现显著的性能优化，特别是在LLM推理的**预填充阶段**。

### 无KV Cache记忆

- 每个新查询都被添加到完整的提示模板中，包括背景知识。
- 模型必须在整个序列上**重新计算token嵌入和注意力**——即使是未更改的记忆。

### 有KV Cache记忆

- 背景知识以键值对张量的形式**缓存一次**。
- 对于每个查询，只对新用户输入（查询token）进行编码。
- 之前缓存的KV被直接注入到注意力机制中。

### 好处

这种分离减少了预填充阶段的冗余计算，从而导致:

- 跳过背景知识的重复编码
- 更快的查询token和缓存记忆之间的注意力计算
- **降低首次token时间(Time To First Token, TTFT)** 生成过程中的延迟

这种优化在以下方面特别有价值:

- 多回合聊天机器人交互
- 检索增强生成或上下文增强生成(RAG, CAG)
- 在固定文档或FAQ风格记忆上操作的助理


### KV Cache记忆加速评估

为了验证基于KV的记忆注入对性能的影响，我们进行了一组在MemOS中模拟真实记忆复用的对照实验。

#### 实验建立

在典型的使用中，`MemScheduler`模块持续跟踪交互模式，并将高频、稳定的明文记忆提升为KV格式。这些KV记忆作为激活缓存加载到GPU内存中，并在推理过程中重复使用。

评估比较两种记忆策略:

1. **基于提示的注入**: 背景知识被作为原始文本添加
2. **KV Cache注入**: 记忆被直接注入到模型的注意力缓存

我们对这些策略进行了测试:

- **三种文本长度**: 短文本, 中等长度文本和长文本
- **三种查询类型**: 短查询, 中等查询和长查询

主要指标是**首次token时间(TTFT)**，这是响应式生成的关键延迟指标。

#### 实验结果

下表显示了跨三个模型的结果(Qwen3-8B, Qwen3-32B, Qwen2.5-72B).KV Cache注入下的TTFT始终低于基于提示的注入，而两种策略的输出token保持一致.

::note{icon="ri:bnb-fill"}
`Build (s)`是指将记忆转换为KV格式的一次性预处理成本，分摊到多个查询中.
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


#### 基于 vLLM 的性能表现

MemOS 现在支持使用 vLLM 管理激活内存。为了评估KV Cache预存不同长度的前缀文本带来的影响，我们在一个配备 8 张 `H800 80GB GPU（112 vCPU，1920 GiB 内存）`的系统，以及一个配备 8张 `RTX4090-24G-PCIe(112 vCPU，960 GiB 内存)` 的系统上分别进行了性能测试。评估覆盖了当前两种核心模型：Qwen3-32B 和 Qwen2.5-72B。

基准测试在一系列记忆和上下文长度组合下运行，以模拟各种激活内存场景：
- **记忆文本长度（tokens）**：500、1000、2000
- **上下文文本长度（tokens）**：500、1000、2000、4000

下表总结了基准测试结果。

**Qwen2.5-72B**
- On 4090（2 Nodes 16 GPUs）

| mem tks | prompt tks | TTFT (without cache, ms) | TTFT (With cache, ms) | TTFT Speedup (%) | Abs Dis(ms) |
| ------- | ---------- | ------------------------ | --------------------- | ---------------- | ----------- |
| 0.5k    | 0.5k       | 1787.21                  | 851.47                | 52.358%          | 935.74      |
| 0.5k    | 1k         | 2506.26                  | 1290.68               | 48.502%          | 1215.58     |
| 0.5k    | 2k         | 3843.48                  | 2897.97               | 24.600%          | 945.51      |
| 0.5k    | 4k         | 6078.01                  | 5200.86               | 14.432%          | 877.15      |
| 1k      | 0.5k       | 2274.61                  | 920.16                | 59.546%          | 1354.45     |
| 1k      | 1k         | 2907.17                  | 1407.65               | 51.580%          | 1499.52     |
| 1k      | 2k         | 4278.53                  | 2916.47               | 31.835%          | 1362.06     |
| 1k      | 4k         | 6897.99                  | 5218.94               | 24.341%          | 1679.05     |
| 2k      | 0.5k       | 3460.12                  | 782.73                | 77.379%          | 2677.39     |
| 2k      | 1k         | 4443.34                  | 1491.24               | 66.439%          | 2952.10     |
| 2k      | 2k         | 5733.14                  | 2758.48               | 51.885%          | 2974.66     |
| 2k      | 4k         | 8152.76                  | 5627.41               | 30.975%          | 2525.35     |


- On H800（4 GPUs）

| mem tks | prompt tks | TTFT (without cache, ms) | TTFT (With cache, ms) | TTFT Speedup (%) | Abs Dis(ms) |
| ------- | ---------- | ------------------------ | --------------------- | ---------------- | ----------- |
| 0.5k    | 0.5k       | 51.65                    | 52.17                 | -1.007%          | -0.52       |
| 0.5k    | 1k         | 55.70                    | 57.03                 | -2.388%          | -1.33       |
| 0.5k    | 2k         | 74.23                    | 78.56                 | -5.833%          | -4.33       |
| 0.5k    | 4k         | 77.56                    | 77.45                 | 0.142%           | 0.11        |
| 1k      | 0.5k       | 55.90                    | 55.73                 | 0.304%           | 0.17        |
| 1k      | 1k         | 55.35                    | 52.89                 | 4.444%           | 2.46        |
| 1k      | 2k         | 80.14                    | 73.82                 | 7.886%           | 6.32        |
| 1k      | 4k         | 82.83                    | 73.51                 | 11.252%          | 9.32        |
| 2k      | 0.5k       | 75.82                    | 71.31                 | 5.948%           | 4.51        |
| 2k      | 1k         | 80.60                    | 78.71                 | 2.345%           | 1.89        |
| 2k      | 2k         | 83.91                    | 78.60                 | 6.328%           | 5.31        |
| 2k      | 4k         | 99.15                    | 80.12                 | 19.193%          | 19.03       |

**Qwen3-32B**

- On 4090（1 Nodes 8 GPUs）

| mem tks | prompt tks | TTFT (without cache, ms) | TTFT (With cache, ms) | TTFT Speedup (%) | Abs Dis(ms) |
| ------- | ---------- | ------------------------ | --------------------- | ---------------- | ----------- |
| 0.5k    | 0.5k       | 288.72                   | 139.29                | 51.756%          | 149.43      |
| 0.5k    | 1k         | 428.72                   | 245.85                | 42.655%          | 182.87      |
| 0.5k    | 2k         | 683.65                   | 538.59                | 21.218%          | 145.06      |
| 0.5k    | 4k         | 1170.48                  | 986.94                | 15.681%          | 183.54      |
| 1k      | 0.5k       | 409.83                   | 137.96                | 66.337%          | 271.87      |
| 1k      | 1k         | 507.95                   | 262.21                | 48.379%          | 245.74      |
| 1k      | 2k         | 743.48                   | 539.71                | 27.408%          | 203.77      |
| 1k      | 4k         | 1325.34                  | 1038.59               | 21.636%          | 286.75      |
| 2k      | 0.5k       | 686.01                   | 147.34                | 78.522%          | 538.67      |
| 2k      | 1k         | 762.96                   | 246.22                | 67.728%          | 516.74      |
| 2k      | 2k         | 1083.93                  | 498.05                | 54.051%          | 585.88      |
| 2k      | 4k         | 1435.39                  | 1053.31               | 26.619%          | 382.08      |


- On H800（2 GPUs）

| mem tks | prompt tks | TTFT (without cache, ms) | TTFT (With cache, ms) | TTFT Speedup (%) | Abs Dis(ms) |
| ------- | ---------- | ------------------------ | --------------------- | ---------------- | ----------- |
| 0.5k    | 0.5k       | 161.18                   | 97.61                 | 39.440%          | 63.57       |
| 0.5k    | 1k         | 164.00                   | 121.39                | 25.982%          | 42.61       |
| 0.5k    | 2k         | 257.34                   | 215.20                | 16.375%          | 42.14       |
| 0.5k    | 4k         | 365.14                   | 317.95                | 12.924%          | 47.19       |
| 1k      | 0.5k       | 169.45                   | 100.52                | 40.679%          | 68.93       |
| 1k      | 1k         | 180.91                   | 128.25                | 29.108%          | 52.66       |
| 1k      | 2k         | 271.69                   | 210.00                | 22.706%          | 61.69       |
| 1k      | 4k         | 389.30                   | 314.64                | 19.178%          | 74.66       |
| 2k      | 0.5k       | 251.43                   | 130.92                | 47.930%          | 120.51      |
| 2k      | 1k         | 275.81                   | 159.60                | 42.134%          | 116.21      |
| 2k      | 2k         | 331.11                   | 218.17                | 34.110%          | 112.94      |
| 2k      | 4k         | 451.06                   | 334.80                | 25.775%          | 116.26      |


结果清楚地表明，集成 vLLM 的 KV 缓存重用功能为 MemOS 带来了革命性的性能提升。

## KV Cache的记忆结构

通过`KVCacheMemory`实现基于KV的记忆复用，在保持相同输出的同时，大大减少了模型大小和查询类型之间的延迟。通过将可复用记忆从明文提示转移到预先计算的KV Cache，MemOS消除了冗余的上下文编码，并实现了更快的响应时间，特别是在实时的、记忆增强的LLM应用程序中。

每个缓存被存储为一个`KVCacheItem`:

| 字段         | 类型           | 描述                                 |
| ------------- | -------------- | ------------------------------------------- |
| `kv_cache_id` | `str`          | 缓存中的唯一ID(UUID)              |
| `kv_cache`    | `DynamicCache` | 实际的KV Cache(transformers)   |
| `metadata`    | `dict`         | 元数据 (源, 抽取时间等.)    |


## API总结 (`KVCacheMemory`)

### 初始化
```python
KVCacheMemory(config: KVCacheMemoryConfig)
```

### 核心方法
| 方法                   | 描述                                              |
| ------------------------ | -------------------------------------------------------- |
| `extract(text)`          | 使用LLM从输入文本中提取KV Cache        |
| `add(memories)`          | 添加一个或多个`KVCacheItem`到记忆中                |
| `get(memory_id)`         | 根据ID获取单个缓存                               |
| `get_by_ids(ids)`        | 根据IDs获取多个缓存                             |
| `get_all()`              | 返回所有存储的缓存                                |
| `get_cache(cache_ids)`   | 从多个IDs合并并返回组合缓存      |
| `delete(ids)`            | 通过IDs删除缓存                                     |
| `delete_all()`           | 删除所有缓存                                        |
| `dump(dir)`              | 将所有缓存序列化到目录中的pickle文件       |
| `load(dir)`              | 从目录中的pickle文件加载缓存              |
| `from_textual_memory(mem)` | 将`TextualMemoryItem` 转换为 `KVCacheItem`      |


当调用`dump(dir)`, 系统写到:

```
<dir>/<config.memory_filename>
```

该文件包含所有KV Cache的pickle字典，可以使用`load(dir)`重新加载。


## 如何使用

### HF KVCache Memory

```python
import json

from transformers import DynamicCache

from memos.configs.memory import MemoryConfigFactory
from memos.memories.activation.item import KVCacheItem
from memos.memories.factory import MemoryFactory


def get_cache_info(cache):
    if not cache:
        return None

    num_layers = 0
    total_size_bytes = 0

    if hasattr(cache, "layers"):
        num_layers = len(cache.layers)
        for layer in cache.layers:
            if hasattr(layer, "key_cache") and layer.key_cache is not None:
                total_size_bytes += layer.key_cache.nelement() * layer.key_cache.element_size()
            if hasattr(layer, "value_cache") and layer.value_cache is not None:
                total_size_bytes += layer.value_cache.nelement() * layer.value_cache.element_size()

            if hasattr(layer, "keys") and layer.keys is not None:
                total_size_bytes += layer.keys.nelement() * layer.keys.element_size()
            if hasattr(layer, "values") and layer.values is not None:
                total_size_bytes += layer.values.nelement() * layer.values.element_size()

    elif hasattr(cache, "key_cache") and hasattr(cache, "value_cache"):
        num_layers = len(cache.key_cache)
        for k, v in zip(cache.key_cache, cache.value_cache, strict=False):
            if k is not None:
                total_size_bytes += k.nelement() * k.element_size()
            if v is not None:
                total_size_bytes += v.nelement() * v.element_size()

    return {
        "num_layers": num_layers,
        "size_bytes": total_size_bytes,
        "size_mb": f"{total_size_bytes / (1024 * 1024):.2f} MB",
    }


def serialize_item(obj):
    if isinstance(obj, list):
        return [serialize_item(x) for x in obj]

    if isinstance(obj, KVCacheItem):
        return {
            "id": obj.id,
            "metadata": obj.metadata,
            "records": obj.records.model_dump()
            if hasattr(obj.records, "model_dump")
            else obj.records,
            "memory": get_cache_info(obj.memory),
        }

    if isinstance(obj, DynamicCache):
        return get_cache_info(obj)

    return str(obj)


if __name__ == "__main__":
    # ===== 示例：使用工厂和 HFLLM 构建及管理 KVCacheMemory =====

    # 1. 创建 KVCacheMemory 配置（使用 HuggingFace 后端）
    config = MemoryConfigFactory(
        backend="kv_cache",
        config={
            "extractor_llm": {
                "backend": "huggingface",
                "config": {
                    "model_name_or_path": "Qwen/Qwen3-0.6B",  # 使用有效的 HuggingFace 模型名称
                    "max_tokens": 32,
                    "add_generation_prompt": True,
                    "remove_think_prefix": True,
                },
            },
        },
    )

    # 2. 使用工厂实例化 KVCacheMemory
    kv_mem = MemoryFactory.from_config(config)

    # 3. 从提示中提取 KVCacheItem (DynamicCache)（内部使用 HFLLM.build_kv_cache）
    prompt = [
        {"role": "user", "content": "What is MemOS?"},
        {"role": "assistant", "content": "MemOS is a memory operating system for LLMs."},
    ]
    print("===== Extract KVCacheItem =====")
    cache_item = kv_mem.extract(prompt)
    print(json.dumps(serialize_item(cache_item), indent=2, default=str))
    print()

    # 4. 添加提取的 KVCacheItem
    print("===== Add KVCacheItem =====")
    kv_mem.add([cache_item])
    print(json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str))
    print()

    # 5. 根据 ID 获取
    print("===== Get KVCacheItem by id =====")
    retrieved = kv_mem.get(cache_item.id)
    print(json.dumps(serialize_item(retrieved), indent=2, default=str))
    print()

    # 6. 合并缓存（使用两个项目进行模拟）
    print("===== Merge DynamicCache =====")
    item2 = kv_mem.extract([{"role": "user", "content": "Tell me a joke."}])
    kv_mem.add([item2])
    merged_cache = kv_mem.get_cache([cache_item.id, item2.id])
    print(json.dumps(serialize_item(merged_cache), indent=2, default=str))
    print()

    # 7. 删除一个
    print("===== Delete one KVCacheItem =====")
    kv_mem.delete([cache_item.id])
    print(json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str))
    print()

    # 8. 转储和加载
    print("===== Dump and Load KVCacheMemory =====")
    kv_mem.dump("tmp/kv_mem")
    print("Memory dumped to 'tmp/kv_mem'.")
    kv_mem.delete_all()
    kv_mem.load("tmp/kv_mem")
    print(
        "Memory loaded from 'tmp/kv_mem':",
        json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str),
    )
```

### VLLM KVCache Memory

```python
#!/usr/bin/env python3
"""
演示如何使用带有 vLLM 后端的 VLLMKVCacheMemory 的示例。
此示例展示了如何使用新的兼容 vLLM 的 KV cache 记忆。
"""

from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory


def main():
    """演示 VLLMKVCacheMemory 用法的主函数。"""

    print("=== VLLM KV Cache Memory Example ===\n")

    # 1. 创建 VLLMKVCacheMemory 配置（使用 vLLM 后端）
    config = MemoryConfigFactory(
        backend="vllm_kv_cache",  # 使用新的 vLLM KV cache 后端
        config={
            "extractor_llm": {
                "backend": "vllm",
                "config": {
                    "model_name_or_path": "Qwen/Qwen3-0.6B",
                    "api_base": "http://localhost:8088/v1",
                    "temperature": 0.7,
                    "max_tokens": 1024,
                    "model_schema": "memos.configs.llm.VLLMLLMConfig",
                },
            },
        },
    )

    # 2. 使用工厂实例化 VLLMKVCacheMemory
    print("Initializing VLLM KV Cache Memory...")
    vllm_kv_mem = MemoryFactory.from_config(config)
    print("✓ VLLM KV Cache Memory initialized successfully.\n")

    # 3. 从提示中提取 VLLMKVCacheItem
    print("===== Extract VLLMKVCacheItem =====")
    system_prompt = [
        {"role": "system", "content": "You are a helpful AI assistant."},
        {"role": "user", "content": "What is MemOS?"},
        {"role": "assistant", "content": "MemOS is a memory operating system for LLMs."},
    ]

    try:
        cache_item = vllm_kv_mem.extract(system_prompt)
        print("✓ KV cache item extracted successfully")
        print(f"  ID: {cache_item.id}")
        print(f"  Memory (prompt): {cache_item.memory[:100]}...")
        print(f"  Metadata: {cache_item.metadata}")
        print()
    except Exception as e:
        print(f"✗ Failed to extract KV cache item: {e}")
        return

    # 4. 添加提取的 VLLMKVCacheItem
    print("===== Add VLLMKVCacheItem =====")
    vllm_kv_mem.add([cache_item])
    all_items = vllm_kv_mem.get_all()
    print(f"✓ Added cache item. Total items: {len(all_items)}")
    print()

    # 5. 根据 ID 获取
    print("===== Get VLLMKVCacheItem by id =====")
    retrieved = vllm_kv_mem.get(cache_item.id)
    if retrieved:
        print(f"✓ Retrieved cache item: {retrieved.id}")
        print(f"  Memory (prompt): {retrieved.memory[:100]}...")
    else:
        print("✗ Failed to retrieve cache item")
    print()

    # 6. 获取缓存（返回 vLLM 的提示字符串）
    print("===== Get Cache (Prompt String) =====")
    prompt_string = vllm_kv_mem.get_cache([cache_item.id])
    if prompt_string:
        print(f"✓ Retrieved prompt string: {prompt_string[:100]}...")
        print("  This prompt can be used for vLLM generation with preloaded KV cache")
    else:
        print("✗ Failed to retrieve prompt string")
    print()

    # 7. 提取另一个缓存项进行演示
    print("===== Extract Another VLLMKVCacheItem =====")
    another_prompt = [
        {"role": "system", "content": "You are a coding assistant."},
        {"role": "user", "content": "Write a Python function to calculate fibonacci numbers."},
    ]

    try:
        cache_item2 = vllm_kv_mem.extract(another_prompt)
        vllm_kv_mem.add([cache_item2])
        print(f"✓ Added second cache item. Total items: {len(vllm_kv_mem.get_all())}")
        print()
    except Exception as e:
        print(f"✗ Failed to extract second KV cache item: {e}")
        print()

    # 8. 在 vLLM 服务器上预加载 KV cache
    print("===== Preload KV Cache on vLLM Server =====")
    try:
        vllm_kv_mem.preload_kv_cache([cache_item.id, cache_item2.id])
        print("✓ KV cache preloaded on vLLM server successfully")
        print("  The server now has the KV cache ready for fast generation")
    except Exception as e:
        print(f"✗ Failed to preload KV cache: {e}")
    print()

    # 9. 删除一个项目
    print("===== Delete One VLLMKVCacheItem =====")
    vllm_kv_mem.delete([cache_item.id])
    remaining_items = vllm_kv_mem.get_all()
    print(f"✓ Deleted cache item. Remaining items: {len(remaining_items)}")
    print()

    # 10. 转储和加载
    print("===== Dump and Load VLLMKVCacheMemory =====")
    try:
        vllm_kv_mem.dump("tmp/vllm_kv_mem")
        print("✓ Memory dumped to 'tmp/vllm_kv_mem'")

        # 清除记忆并重新加载
        vllm_kv_mem.delete_all()
        vllm_kv_mem.load("tmp/vllm_kv_mem")
        reloaded_items = vllm_kv_mem.get_all()
        print(f"✓ Memory loaded from 'tmp/vllm_kv_mem': {len(reloaded_items)} items")
    except Exception as e:
        print(f"✗ Failed to dump/load memory: {e}")
    print()

    print("=== Example completed successfully ===")


if __name__ == "__main__":
    main()
```

## 开发者注意事项

* 使用HuggingFace `DynamicCache` 高效的键值存储
* 基于pickle的序列化，用于快速加载/保存
* `/tests`中的集成测试涵盖了所有方法。
