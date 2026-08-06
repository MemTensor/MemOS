---
title: "MemReader"
desc: “MemReader 是你的“记忆翻译官”。它负责把杂乱的输入（聊天、文档、图片）翻译成系统能理解的、结构化的记忆片段。"
---

## 1. 简介

在构建 AI 应用时，我们经常遇到这样的问题：用户发来的东西千奇百怪——有的是随口的聊天，有的是 PDF 文档，有的是图片。**MemReader** 的作用就是把这些原始数据（Raw Data）“嚼碎”并“消化”，变成带有 Embedding 和元数据的标准记忆块（Memory Item）。

简单来说，它做三件事：
1.  **归一化**：不管你发来的是字符串还是 JSON，先统一变成标准格式。
2.  **切片 (Chunking)**：把长对话或长文档切成合适的小块，方便后续处理。
3.  **精炼 (Extraction)**：调用 LLM 把非结构化的信息提取成结构化的知识点（Fine 模式），或者直接生成快照（Fast 模式）。

---

## 2. 核心模式

MemReader 设计了两种工作模式，分别对应“快”和“准”两种需求：

### ⚡ Fast 模式（唯快不破）
*   **特点**：**不调用 LLM**，只做切片和 Embedding。
*   **适用场景**：
    *   用户发消息飞快，系统需要毫秒级响应。
    *   只需保留对话的“快照”，不需要深度理解。
*   **产物**：原始文本片段 + 向量索引 + 来源追踪 (Sources)。

### 🧠 Fine 模式（精雕细琢）
*   **特点**：**调用 LLM** 进行深度分析。
*   **适用场景**：
    *   长时记忆写入（需要提取关键事实）。
    *   文档分析（需要总结核心观点）。
    *   多模态理解（需要看懂图片里的内容）。
*   **产物**：结构化的事实 + 关键信息提取 (Key) + 背景 (Background) + 向量索引 + 来源追踪 (Sources) + 多模态细节。

---

## 3. 代码结构

MemReader 的代码结构非常清晰，主要由以下几部分组成：

*   **`base.py`**: 定义了所有 Reader 必须遵守的接口规范。
*   **`simple_struct.py`**: **最常用的实现**。专攻纯文本对话和本地文档，轻量高效。
*   **`multi_modal_struct.py`**: **全能型选手**。能处理图片、文件 URL、Tool 调用等复杂输入。
*   **`read_multi_modal/`**: 存放了各种具体的解析器（Parser），比如专门解析图片的 `ImageParser`，解析文件的 `FileParser` 等。

---

## 4. 如何选择？

| 你的需求 | 推荐选择 | 理由 |
| :--- | :--- | :--- |
| **只处理纯文本对话** | `SimpleStructMemReader` | 简单、直接、性能好。 |
| **需要处理图片、文件链接** | `MultiModalStructMemReader` | 内置了多模态解析能力。 |
| **需要从 Fast 升级到 Fine** | 任意 Reader 的 `fine_transfer` 方法 | 支持“先存后优”的渐进式策略。 |

---

## 5. API 概览

### 统一工厂：`MemReaderFactory`

不要自己去 `new` 对象，使用工厂模式是最佳实践：

```python
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.mem_reader.factory import MemReaderFactory

# 从配置创建 Reader
cfg = MemReaderConfigFactory.model_validate({...})
reader = MemReaderFactory.from_config(cfg)
```

### 核心方法：`get_memory()`

这是你最常调用的方法。

```python
memories = reader.get_memory(
    scene_data,       # 你的输入数据
    type="chat",      # 类型：chat 或 doc
    info=user_info,   # 用户信息（user_id, session_id）
    mode="fine"       # 模式：fast 或 fine（强烈建议显式指定！）
)
```

**返回结果**：`list[list[TextualMemoryItem]]`

::note{icon="ri:bnb-fill"}
为什么是双层列表？
因为一个长对话可能会被切成多个窗口（Window），外层列表代表窗口，内层列表代表该窗口提取出的记忆项。
::

---

## 6. 开发实战

### 场景一：处理简单的聊天记录

这是最基础的用法，使用 `SimpleStructMemReader`。

```python
# 1. 准备输入：标准的 OpenAI 格式对话
conversation = [
    [
        {"role": "user", "content": "我明天下午 3 点有个会"},
        {"role": "assistant", "content": "会议主题是什么？"},
        {"role": "user", "content": "讨论 Q4 项目截止日期"},
    ]
]

# 2. 提取记忆 (Fine 模式)
memories = reader.get_memory(
    conversation,
    type="chat",
    mode="fine",
    info={"user_id": "u1", "session_id": "s1"}
)

# 3. 结果
# memories 里会包含提取出的事实，例如："用户明天下午3点有关于Q4项目的会议"
```

### 场景二：处理多模态输入

当用户发来图片或文件链接时，切换到 `MultiModalStructMemReader`。

```python
# 1. 准备输入：包含文件和图片的复杂消息
scene_data = [
    [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "看看这个文件和图片"},
                # 文件支持 URL 自动下载解析
                {"type": "file", "file": {"file_data": "https://example.com/readme.md"}},
                # 图片支持 URL
                {"type": "image_url", "image_url": {"url": "https://example.com/chart.png"}},
            ]
        }
    ]
]

# 2. 提取记忆
memories = multimodal_reader.get_memory(
    scene_data,
    type="chat",
    mode="fine", # 只有 Fine 模式才会调用视觉模型解析图片
    info={"user_id": "u1", "session_id": "s1"}
)
```

### 场景三：渐进式优化 (Fine Transfer)

为了用户体验，你可以先用 Fast 模式快速存下对话，等系统空闲时再把它“精炼”成 Fine 记忆。

```python
# 1. 先快速存（毫秒级）
fast_memories = reader.get_memory(conversation, mode="fast", ...)

# ... 存入数据库 ...

# 2. 后台异步精炼
refined_memories = reader.fine_transfer_simple_mem(
    fast_memories_flat_list, # 注意这里传入的是展平后的 Item 列表
    type="chat"
)

# 3. 用 refined_memories 替换掉原来的 fast_memories
```

---

## 7. 配置项说明

在 `.env` 或配置文件中，你可以调整以下关键参数：

*   **`chat_window_max_tokens`**: **滑窗大小**。默认 1024。决定了多少上下文会被打包在一起处理。设得太小容易丢失语境，设得太大容易超出 LLM 的 Token 限制。
*   **`remove_prompt_example`**: **是否移除 Prompt 里的示例**。True = 省 Token 但可能降低提取质量；False = 保留示例提高准确度但消耗更多 Token（保留 Few-shot 示例）。
*   **`direct_markdown_hostnames`** (仅多模态): **域名白名单**。列表中的域名（如 `raw.githubusercontent.com`）会被直接当作 Markdown 文本处理，跳过 OCR/格式转换步骤，加速处理。
