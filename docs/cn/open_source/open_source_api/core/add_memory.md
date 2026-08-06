---
title: 添加记忆 (Add Memory)
desc: MemOS 的核心生产接口。通过 MemCube 隔离机制，实现个人记忆、知识库及多租户场景下的异步记忆生产。
---

**接口路径**：`POST /product/add`
**功能描述**：这是系统存储非结构化数据的核心入口。它支持通过对话列表、纯文本或元数据，将原始数据转化为结构化的记忆片段。在开源版中，系统通过 **MemCube** 实现记忆的物理隔离与动态组织。

## 1. 核心机理：MemCube 与隔离

在开源架构中，理解 MemCube 是高效使用接口的关键：

* **隔离单元**：MemCube 是记忆生成的原子单位，Cube 之间完全独立，系统仅在单个 Cube 内部进行去重和冲突解决。
* **灵活映射**：
    * **个人模式**：将 `user_id` 作为 `writable_cube_ids` 传入，即建立个人私有记忆。
    * **知识库模式**：将知识库的唯一标识（QID）作为 `writable_cube_ids` 传入，内容即存入该知识库。
* **多目标写入**：接口支持同时向多个 Cube 写入记忆，实现跨域同步。


## 2. 关键接口参数

核心参数定义如下：

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | 是 | - | 用户唯一标识符，用于权限校验。 |
| **`messages`** | `list/str`| 是 | - | 待存储的消息列表或纯文本内容。 |
| **`writable_cube_ids`** | `list[str]`| 是 | - | **核心参数**：指定写入的目标 Cube ID 列表。 |
| **`async_mode`** | `str` | 否 | `async` | 处理模式：`async` (后台队列处理) 或 `sync` (当前请求阻塞)。 |
| **`is_feedback`** | `bool` | 否 | `false` | 若为 `true`，系统将自动路由至反馈处理器执行记忆更正。 |
| `session_id` | `str` | 否 | `default` | 会话标识符，用于追踪对话上下文。 |
| `custom_tags` | `list[str]`| 否 | - | 自定义标签，可作为后续搜索时的过滤条件。 |
| `info` | `dict` | 否 | - | 扩展元数据。其中的所有键值对均支持后续过滤检索。 |
| `mode` | `str` | 否 | - | 仅在 `async_mode='sync'` 时生效，可选 `fast` (快速) 或 `fine` (精细)。 |

## 3. 工作原理 (Component & Handler)

当请求到达后端时，系统由 **AddHandler** 调度核心组件执行以下逻辑：

1. **多模态解析**：由 `MemReader` 组件将 `messages` 转化为内部记忆对象。
2. **反馈路由**：若 `is_feedback=True`，Handler 会提取对话末尾作为反馈，直接修正已有记忆，不生成新事实。
3. **异步分发**：若为 `async` 模式，`MemScheduler` 将任务推入任务队列，接口立即返回 `task_id`。
4. **内部组织**：算法在目标 Cube 内执行组织逻辑，通过去重和融合优化记忆质量。

## 4. 快速上手示例

推荐使用 `MemOSClient` SDK 进行标准化调用：

```python
from memos.api.client import MemOSClient

# 初始化客户端
client = MemOSClient(api_key="...", base_url="...")

# 场景一：为个人用户添加记忆
client.add_message(
    user_id="sde_dev_01",
    writable_cube_ids=["user_01_private"],
    messages=[{"role": "user", "content": "我正在学习 R 语言的 ggplot2。"}],
    async_mode="async",
    custom_tags=["Programming", "R"]
)
# 场景二：往知识库导入内容并开启反馈
client.add_message(
    user_id="admin_01",
    writable_cube_ids=["kb_finance_2026"],
    messages="2026年财务审计流程已更新，请参考附件。",
    is_feedback=True, # 标记为反馈以更正旧版流程
    info={"source": "Internal_Portal"}
)
```
