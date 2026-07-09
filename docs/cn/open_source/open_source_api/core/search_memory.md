---
title: 检索记忆 (Search Memory)
desc: 基于 MemCube 隔离机理，利用语义检索和逻辑过滤从记忆库中召回最相关的上下文信息。
---

**接口路径**：`POST /product/search`
**功能描述**：本接口是 MemOS 实现检索增强生成 (RAG) 的核心。它能够跨越多个隔离的 **MemCube** 进行语义匹配，自动召回相关的事实、用户偏好及工具调用记录。

## 1. 核心机理：Readable Cubes

与云服务的单一用户视角不同，开源版接口通过 **`readable_cube_ids`** 实现了极其灵活的检索范围控制：

* **跨 Cube 检索**：您可以同时指定多个 Cube ID（如 `[用户私有Cube, 企业公共知识库Cube]`），算法会并行从这些隔离的记忆体中召回最相关内容。
* **软信号权重**：通过传入 `session_id`，系统会在召回时优先考虑该会话内的内容。这仅作为提升相关性的“权重”，而非强制过滤。
* **绝对隔离**：未包含在 `readable_cube_ids` 列表中的 Cube 内容在算法层是完全不可见的，确保了多租户环境下的数据安全性。



## 2. 关键接口参数

核心检索参数定义如下：

### 检索基础
| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`query`** | `str` | 是 | 用户的搜索查询语句，系统将基于此进行语义匹配。 |
| **`user_id`** | `str` | 是 | 请求发起者的唯一标识，用于鉴权与上下文追踪。 |
| **`readable_cube_ids`**| `list[str]`| 是 | **核心参数**：指定本次检索可读取的 Cube ID 列表。 |
| **`mode`** | `str` | 否 | **搜索策略**：可选 `fast` (快速), `fine` (精细), `mixture` (混合)。 |

### 召回控制
| 参数名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **`top_k`** | `int` | `10` | 召回文本记忆的数量上限。 |
| **`include_preference`**| `bool` | `true` | 是否召回相关的用户偏好记忆（显式/隐式偏好）。 |
| **`search_tool_memory`**| `bool` | `true` | 是否召回相关的工具调用记录。 |
| **`filter`** | `dict` | - | 逻辑过滤器，支持按标签或元数据进行精确过滤。 |
| **`dedup`** | `str` | - | 去重策略：`no` (不去重), `sim` (语义去重), `None` (默认精确文本去重)。 |

## 3. 工作原理 (SearchHandler 策略)

当请求到达后端时，**SearchHandler** 会根据指定的 `mode` 调用不同的组件执行检索：

1. **查询重写**：利用 LLM 对用户的 `query` 进行语义增强，提升匹配精度。
2. **多模式匹配**：
    * **Fast 模式**：通过向量索引进行快速召回，适用于对响应速度要求极高的场景。
    * **Fine 模式**：增加重排序（Rerank）环节，提升召回内容的相关度。
    * **Mixture 模式**：结合语义搜索与图谱搜索，召回更具深度的关联记忆。
3. **多维聚合**：系统并行检索事实、偏好（`pref_top_k`）和工具记忆（`tool_mem_top_k`），并将结果聚合返回。
4. **后处理去重**：根据 `dedup` 配置对高度相似的记忆条目进行压缩。

## 4. 快速上手示例

通过 SDK 进行多 Cube 联合检索：

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# 场景：同时检索用户记忆和两个专业知识库
res = client.search_memory(
    user_id="sde_dev_01",
    query="根据我之前的偏好，推荐一些 R 语言的可视化方案",
    # 传入可读的 Cube 列表，包括个人空间和两个知识库
    readable_cube_ids=["user_01_private", "kb_r_lang", "kb_data_viz"],
    mode="fine",             # 使用精细模式以获得更准确的推荐
    include_preference=True,  # 召回“用户喜欢简洁风格”等偏好
    top_k=5
)

if res:
    # 结果包含在 memory_detail_list 中
    print(f"召回结果: {res.data}")
```

## 5.进阶：使用过滤器 (Filter)
SearchHandler 支持复杂的过滤器，以满足更细粒度的业务需求：
```python

# 示例：仅搜索标签为 "Programming" 且创建于 2026 年之后的记忆
search_filter = {
    "and": [
        {"tags": {"contains": "Programming"}},
        {"created_at": {"gt": "2026-01-01"}}
    ]
}

res = client.search_memory(
    query="数据清洗逻辑",
    user_id="sde_dev_01",
    readable_cube_ids=["user_01_private"],
    filter=search_filter
)
```
