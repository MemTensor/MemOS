---
title: 添加反馈
desc: 提交用户对大模型回复的反馈内容，帮助 MemOS 实时更正、优化或删除不准确的记忆。
---


**接口路径**：`POST /product/feedback`
**功能描述**：本接口用于处理用户对 AI 回复或记忆内容的反馈。通过分析 `feedback_content`，系统可以自动定位并修改存储在 **MemCube** 中的错误事实，或根据用户的正负反馈调整记忆的权重。

## 1. 核心机理：记忆纠偏循环

**FeedbackHandler** 提供了比普通添加接口更精细的控制逻辑：

* **精确修正 (Precise Correction)**：通过提供 `retrieved_memory_ids`，系统可以直接针对某几条特定的检索结果进行更正，避免误伤其他记忆。
* **语境分析**：结合 `history`（对话历史），系统能够理解反馈背后的真实意图（例如“你说错了，我现在的公司是 A 而不是 B”）。
* **结果回显**：如果开启 `corrected_answer=true`，接口在处理完记忆更正后，会尝试返回一个基于新事实生成的更正后回答。

## 2. 关键接口参数
本接口核心参数定义如下：

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | 是 | - | 用户唯一标识符。 |
| **`history`** | `list` | 是 | - | 最近的对话历史，用于提供反馈的语境。 |
| **`feedback_content`** | `str` | 是 | - | **核心：** 用户的反馈文本内容。 |
| **`writable_cube_ids`**| `list` | 否 | - | 需要执行记忆更正的目标 Cube 列表。 |
| `retrieved_memory_ids` | `list` | 否 | - | 可选。上一次检索出的、需要被修正的特定记忆 ID 列表。 |
| `async_mode` | `str` | 否 | `async` | 处理模式：`async` (后台处理) 或 `sync` (实时处理并等待)。 |
| `corrected_answer` | `bool` | 否 | `false` | 是否需要系统在修正记忆后返回一个纠正后的新回答。 |
| `info` | `dict` | 否 | - | 附加元数据。 |

## 3. 工作原理

1. **冲突检测**：`FeedbackHandler` 接收反馈后，会对比 `history` 与 `writable_cube_ids` 中现有的记忆事实。
2. **定位与更新**：
    * 若提供了 `retrieved_memory_ids`，则直接更新对应节点。
    * 若未提供 ID，系统通过语义匹配找到最相关的过时记忆进行覆盖或标记为无效。
3. **权重调整**：对于态度模糊的反馈，系统会调整特定记忆条目的 `confidence`（置信度）或可信度等级。
4. **异步生产**：在 `async` 模式下，修正逻辑由 `MemScheduler` 异步执行，接口立即返回 `task_id`。

## 4. 快速上手示例


```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# 场景：修正 AI 关于用户饮食偏好的错误记忆
res = client.add_feedback(
    user_id="dev_user_01",
    conversation_id="conv_diet_001",
    feedback_content="我不再减肥了，现在不需要控制饮食。"
)

if res and res.code == 200:
    print(f"反馈已提交: {res.message}")
```


## 5. 使用场景
### 5.1 纠正 AI 的错误推断
人工干预：在管理后台提供“纠错”按钮，当管理员发现 AI 提取的记忆条目有误时，调用此接口进行人工更正。
### 5.2 更新过时的用户偏好
用户即时纠偏：在对话 UI 中，如果用户说出类似“记错了”、“不是这样的”等话语，可以自动触发此接口，利用 is_feedback=True 实现记忆的实时净化。

::note
如果反馈涉及的是公共知识库，请确保当前用户拥有对该 Cube 的写入权限。
::
