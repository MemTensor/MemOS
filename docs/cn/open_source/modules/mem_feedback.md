---
title: MemFeedback
desc: "MemFeedback 是你的“记忆错题本”，让你的 Agent 能够听懂“你记错了”，并自动修正记忆库。它是实现记忆自进化的关键组件。"
---

## 1. 简介

**MemFeedback** 是 MemOS 的“后悔药”。

在长时记忆系统中，最头疼的往往不是“记不住”，而是“记错了改不掉”。当用户说“不，我的生日是明天”或者“把这个项目的代号改成 X”时，简单的 RAG 系统通常无能为力。

MemFeedback 能够听懂这些自然语言指令，自动去数据库里精准定位冲突的记忆，并执行原子级的修正操作（比如把旧记忆归档、写入新记忆）。通过它，你的 Agent 能够像人一样在交流中不断纠错和学习。

---

## 2. 核心能力

它能处理四种常见的反馈场景：

### 纠错 (Correction)
用户指出事实错误。系统不会粗暴地删除旧数据，而是将其**归档 (Archive)**，并写入新数据。这样既修正了错误，又保留了版本历史（Traceability）。如果是正在进行的对话（WorkingMemory），则直接原地更新，保证上下文连贯。

### 补充 (Addition)
如果用户只是补充了新信息，且与旧记忆不冲突，那就很简单——直接作为新节点存入记忆库。

### 全局替换 (Keyword Replacement)
类似于 IDE 里的“全局重构”。比如用户说“把所有文档里的‘张三’都改成‘李四’”，系统会结合 Reranker 自动圈定受影响的文档范围，批量更新所有相关记忆。

### 偏好进化 (Preference Evolution)
专门处理“我不吃香菜”、“我喜欢 Python”这类偏好。系统会记录下这个偏好产生的场景，不断丰富用户画像，让 Agent 越用越顺手。

---

## 3. 代码结构

核心逻辑都在 `memos/src/memos/mem_feedback/` 下。

*   **`simple_feedback.py`**: **推荐直接看这个**。它是官方封装好的版本，把 LLM、向量数据库、检索器都组装好了，开箱即用。
*   **`feedback.py`**: 核心实现类 `MemFeedback`。脏活累活都在这儿：意图识别、冲突比对、安全风控。
*   **`base.py`**: 接口定义。
*   **`utils.py`**: 工具箱。

---

## 4. 关键接口

主入口就一个：`process_feedback()`。通常在 RAG 流程结束、用户给出反馈后异步调用。

### 4.1 输入参数

| 参数 | 说明 |
| :--- | :--- |
| `user_id` / `user_name` | 用户标识与 Cube ID。 |
| `chat_history` | 对话历史，让 LLM 知道你们刚才聊了啥。 |
| `feedback_content` | 用户说的那句反馈（比如“不对，是五点”）。 |
| **`retrieved_memory_ids`** | **必填项（强烈建议）**。把上一轮 RAG 检索到的记忆 ID 传进来，相当于给了系统一个“靶子”，告诉它要修正哪条记忆。如果不传，系统得自己去海量记忆里重新搜，不仅慢，还容易改错。 |
| `corrected_answer` | 是否顺便生成一句修正后的回复。 |

### 4.2 输出结果

返回一个字典，告诉你这次操作改了什么：
*   **`record`**: 数据库变更明细（比如 `{ "add": [...], "update": [...] }`）。
*   **`answer`**: 给用户的自然语言回复。

---

## 5. 工作流程

MemFeedback 的工作流程像是一个严谨的编辑部：

1.  **审稿 (意图识别)**: 先看用户是在纠错、补充信息，还是在改名。
2.  **定位 (召回)**: 找到要修改的那条记忆（如果你传了 ID，这步就省了）。
3.  **校对 (比对)**: 让 LLM 仔细比对新旧信息，确定是完全新增 (ADD) 还是需要更新 (UPDATE)。
4.  **风控 (安全检查)**: 防止 LLM 瞎改。比如 ID 对不对？是不是要把一篇长文档全删了？（会有阈值拦截）。
5.  **出版 (写入)**: 最后执行图数据库操作，归档旧的，写入新的。

---

## 6. 开发示例

这里有一份可运行的代码清单，展示了如何初始化服务、预置一个“错误记忆”，然后通过用户反馈将其修正。

### 6.1 准备工作

首先，我们需要初始化 `SimpleMemFeedback` 服务。

```python
# 假设 llm, embedder, graph_db 等组件已通过 Factory 初始化完成
# 完整初始化代码请参考 examples/mem_feedback/example_feedback.py

from memos.mem_feedback.simple_feedback import SimpleMemFeedback

feedback_server = SimpleMemFeedback(
    llm=llm,
    embedder=embedder,
    graph_store=graph_db,
    memory_manager=memory_manager,
    mem_reader=mem_reader,
    searcher=searcher,
    reranker=mem_reranker,
    pref_mem=None,
)
```

### 6.2 模拟场景与执行反馈

场景：系统错误地记住了“你喜欢苹果，不喜欢香蕉”，现在我们要纠正它。

```python
import json
from memos.mem_feedback.utils import make_mem_item

# 1. 模拟对话历史
# 用户问偏好，助手答错了
history = [
    {"role": "user", "content": "我喜欢什么水果,不喜欢什么水果"},
    {"role": "assistant", "content": "你喜欢苹果,不喜欢香蕉"},
]

# 2. 预置“错误记忆”
# 我们手动往库里塞一条错误的事实
mem_text = "你喜欢苹果,不喜欢香蕉"
# ... (省略 make_mem_item 的详细参数，见源码) ...
memory_manager.add([make_mem_item(mem_text, ...)], ...)

# 3. 用户反馈
feedback_content = "错了,实际上我喜欢的是山竹"
print(f"Feedback Input: {feedback_content}")

# 4. 执行修正
# MemFeedback 会发现冲突，把旧记忆归档，写入新记忆“喜欢山竹”
res = feedback_server.process_feedback(
    ...,
    chat_history=history,
    feedback_content=feedback_content,
    ...
)

# 5. 查看结果
print(json.dumps(res, indent=4))
```

---

## 7. 配置说明

要让 MemFeedback 转起来，你需要准备好以下组件的配置（通常在 `.env` 或 YAML 里）：

*   **LLM (`extractor_llm`)**: 脑子要好使，建议用 GPT-4o 级别的模型。Temperature 设低点（比如 0），因为它要干的是逻辑分析，不需要太发散。
*   **Embedder (`embedder`)**: 用于把新记忆变成向量。
*   **GraphDB (`graph_db`)**: 记忆存在哪、怎么存，这两兄弟负责。
*   **MemReader (`mem_reader`)**: 如果是纯新增的记忆，用它来解析。


---
