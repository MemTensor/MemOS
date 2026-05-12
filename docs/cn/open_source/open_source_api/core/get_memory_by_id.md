---
title: 获取记忆详情 (Get Memory Detail)
desc: 通过记忆唯一标识符 (ID) 获取单条记忆的完整元数据，包括置信度、背景信息及使用记录。
---

**接口路径**：`GET /product/get_memory/{memory_id}`
**功能描述**：本接口允许开发者检索单条记忆的所有底层细节。与返回摘要信息的检索接口不同，此接口会暴露该记忆的生命周期数据（如向量同步状态、AI 提取背景等），是系统管理与故障排查的核心工具。

## 1. 为什么需要获取详情？

* **元数据透视**：查看 AI 在提取该条记忆时的 `confidence`和 `background`。
* **生命周期检验**：确认该记忆的 `vector_sync`（向量同步）是否成功，以及其 `updated_at` 时间戳。
* **使用追踪**：通过 `usage` 记录，追踪该记忆在哪些会话中被召回并辅助了生成。


## 2. 关键接口参数

该接口采用标准的 RESTful 路径参数形式：

| 参数名 | 位置 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **`memory_id`** | Path | `str` | 是 | 记忆的唯一标识符（UUID）。您可以从 [**获取记忆列表**](./get_memory_list.md) 或 [**检索**](./search_memory.md) 的结果中获得此 ID。 |

## 3. 工作原理 (MemoryHandler)

1. **直通查询**：由 **MemoryHandler** 直接绕过业务编排层，与底层核心组件 **naive_mem_cube** 交互。
2. **数据补全**：系统会从持久化数据库中拉取完整的 `metadata` 字典并返回，不进行任何语义截断。

## 4. 响应数据详解

响应体中的 `data` 对象包含以下核心字段：

| 字段名 | 说明 |
| :--- | :--- |
| **`id`** | 记忆唯一标识符。 |
| **`memory`** | 记忆的文本内容，通常包含标注（如 `[user观点]`）。 |
| **`metadata.confidence`** | AI 提取该记忆的置信度分数（0.0 - 1.0）。 |
| **`metadata.type`** | 记忆分类，如 `fact` (事实) 或 `preference` (偏好)。 |
| **`metadata.background`** | 详细描述 AI 为何提取该记忆及其上下文背景。 |
| **`metadata.usage`** | 列表形式，记录该记忆被模型使用的历史时间与环境。 |
| **`metadata.vector_sync`**| 向量数据库同步状态，通常为 `success`。 |

## 5. 快速上手示例

使用 SDK 发起详情查询：

```python
# 假设已知一条记忆的 ID
mem_id = "2f40be8f-736c-4a5f-aada-9489037769e0"

# 获取完整详情
res = client.get_memory_by_id(memory_id=mem_id)

if res and res.code == 200:
    metadata = res.data.get('metadata', {})
    print(f"记忆背景: {metadata.get('background')}")
    print(f"同步状态: {metadata.get('vector_sync')}")
```
