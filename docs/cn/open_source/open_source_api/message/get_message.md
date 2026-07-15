---
title: 获取消息
desc: 获取指定会话中的用户与助手原始对话历史，用于构建聊天 UI 或提取原始语境。
---

::warning
**[直接看 API文档 点这里哦](/api_docs/message/get_message)**
<br>
<br>

**本文聚焦于开源项目的功能说明，详细接口字段及限制请点击上方文字链接查看**
::

**接口路径**：`POST /product/get/message`
**功能描述**：该接口用于获取指定会话中用户与助手的原始对话记录。与返回摘要信息的“记忆”接口不同，此接口返回的是未经加工的原始文本，是构建聊天历史回溯功能的核心接口。

## 1. 记忆 (Memory) vs 消息 (Message)

在开发过程中，请区分以下两类数据：
* **获取记忆 (`/get_memory`)**：返回的是系统处理后的**事实与偏好摘要**（例如：“用户喜欢 R 语言进行可视化”）。
* **获取消息 (`/get_message`)**：返回的是**原始对话文本**（例如：“我最近在自学 R 语言，推荐个可视化包”）。

## 2. 关键接口参数
本接口支持以下参数：

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `user_id` | `str` | 是 | - | 与获取消息关联的用户唯一标识符。 |
| `conversation_id` | `str` | 否 | `None` | 指定会话的唯一标识符。 |
| `message_limit_number` | `int` | 否 | `6` | 限制返回的消息条数，最大建议值为 50。 |
| `conversation_limit_number`| `int` | 否 | `6` | 限制返回的会话历史条数。 |
| `source` | `str` | 否 | `None` | 标识消息的来源渠道。 |

## 3. 工作原理


1. **定位会话**：系统根据提供的 `conversation_id` 在底层存储中检索属于该用户及会话的消息记录。
2. **切片处理**：根据 `message_limit_number` 参数，系统从最新的消息开始倒序截取指定条数，确保返回的是最近的对话。
3. **安全隔离**：所有请求均通过 `RequestContextMiddleware` 中间件，严格校验 `user_id` 的归属权，防止越权访问。

## 4. 快速上手示例

使用开源版内置的 `MemOSClient` 快速拉取对话历史：

```python
from memos.api.client import MemOSClient

# 初始化客户端
client = MemOSClient(
    api_key="YOUR_LOCAL_API_KEY",
    base_url="http://localhost:8000/product"
)

# 获取指定会话的最近 10 条对话记录
res = client.get_message(
    user_id="memos_user_123",
    conversation_id="conv_r_study_001",
    message_limit_number=10
)

if res and res.code == 200:
    # 遍历返回的消息列表
    for msg in res.data:
        print(f"[{msg['role']}]: {msg['content']}")
```

## 5. 使用场景
### 5.1 聊天 UI 历史加载
当用户点击进入某个历史会话时，调用此接口可恢复对话现场。建议结合 `message_limit_number` 实现分页加载，提升前端性能。

### 5.2 外部模型上下文注入
如果您正在使用自定义的大模型逻辑（非 MemOS 内置 chat 接口），可以通过此接口获取原始对话历史，并将其手动拼接至模型的 messages 数组中。

### 5.3 消息回溯分析
您可以定期导出原始对话记录，用于评估 AI 的回复质量或分析用户的潜在意图。
