---
title: 获取记忆 (Get Memories)
desc: 分页查询或全量导出指定 Cube 中的记忆集合，支持按类型过滤及子图提取。
---

**接口路径**：
* **分页查询**：`POST /product/get_memory`
* **全量导出**：`POST /product/get_all`

**功能描述**：用于列出或导出指定 **MemCube** 中的记忆资产。通过这两个接口，您可以获取系统生成的原始记忆片段、用户偏好或工具使用记录，支持分页展示与结构化导出。

## 1. 核心机理：分页 vs. 全量导出

在开源版中，系统通过 **MemoryHandler** 提供了两种不同的集合访问模式：

* **业务分页模式 (`/get_memory`)**：
    * **设计初衷**：为前端 UI 列表设计。支持 `page` 和 `page_size` 参数。
    * **特性**：默认包含偏好记忆（`include_preference`），支持轻量级的数据加载。
* **全量导出模式 (`/get_all`)**：
    * **设计初衷**：为数据迁移或复杂关系分析设计。
    * **核心能力**：支持传入 `search_query` 提取相关的**子图（Subgraph）**，或按 `memory_type`（文本/动作/参数）导出全量数据。


## 2. 关键接口参数

### 2.1 分页查询参数 (`/get_memory`)

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`mem_cube_id`** | `str` | 是 | 目标 MemCube ID。 |
| **`user_id`** | `str` | 否 | 用户唯一标识符。 |
| **`page`** | `int` | 否 | 页码（从 1 开始）。若设为 `None` 则尝试全量导出。 |
| **`page_size`** | `int` | 否 | 每页条目数。 |
| `include_preference` | `bool` | 否 | 是否包含偏好记忆。 |

### 2.2 全量/子图导出参数 (`/get_all`)

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | 是 | 用户 ID。 |
| **`memory_type`** | `str` | 是 | 记忆类型：`text_mem`, `act_mem`, `para_mem`。 |
| `mem_cube_ids` | `list` | 否 | 待导出的 Cube ID 列表。 |
| `search_query` | `str` | 否 | 若提供，将基于此查询召回并返回相关的记忆子图。 |

## 3. 快速上手示例

### 3.1 前端分页展示 (SDK 调用)

```python
# 获取第一页，每页 10 条记忆
res = client.get_memory(
    user_id="sde_dev_01",
    mem_cube_id="cube_research_01",
    page=1,
    page_size=10
)

for mem in res.data:
    print(f"[{mem['type']}] {mem['memory_value']}")
```
### 3.2 导出特定的事实记忆子图
```python
# 提取与“R 语言”相关的全部事实记忆
res = client.get_all(
    user_id="sde_dev_01",
    memory_type="text_mem",
    search_query="R language visualization"
)
```

## 4. 响应结构说明
接口返回标准的业务响应，其中 data 包含记忆对象数组。每条记忆通常包含以下核心字段：

`id`: 记忆唯一标识，用于执行 获取详情 或 删除 操作。

`memory_value`: 经过算法加工后的记忆文本。

`tags`: 关联的自定义标签。

::note
开发者提示： 如果您已知记忆 ID 并希望查看其完整的元数据（如 confidence 或 usage 记录），请使用`获取记忆详情`（Get_ memory_by_id）接口。 :::
