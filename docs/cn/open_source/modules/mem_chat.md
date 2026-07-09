---
title: MemChat
desc: "MemChat 是你的“记忆外交官”，它协调用户输入、记忆检索与 LLM 生成，打造连贯且具备长期记忆的对话体验。"
---

## 1. 简介

**MemChat** 是 MemOS 的对话控制中心。

它不仅仅是一个聊天接口，更是连接“即时对话”与“长时记忆”的桥梁。在与用户交流的过程中，MemChat 负责实时地从 MemCube（记忆立方体）中检索相关背景信息，构建上下文，并将新的对话内容沉淀为新的记忆。通过它，你的 Agent 不再是“金鱼记忆”，而是能够真正理解过往、持续成长的智能伙伴。

---

## 2. 核心能力

### 记忆增强对话 (Memory-Augmented Chat)
在回答用户问题前，MemChat 会自动从 MemCube 中检索相关的 Textual Memory（文本记忆），将其注入到 Prompt 中。这使得 Agent 能够基于过往的交互历史或知识库来回答问题，而不仅仅依赖于 LLM 的预训练知识。

### 自动记忆沉淀 (Auto-Memorization)
对话后，MemChat 会利用 Extractor LLM 自动从对话流中提取有价值的信息（如用户偏好、事实知识），并存储到 MemCube 中。无需用户手动干预，整个过程完全自动化。

### 上下文管理
自动管理对话历史窗口 (`max_turns_window`)。当对话过长时，它会智能裁剪旧的上下文，同时依赖检索到的长期记忆来保持对话的连贯性，有效解决了 LLM Context Window 的限制问题。

### 灵活配置
支持通过配置开关不同类型的记忆（文本记忆、激活记忆等），适应不同的应用场景。

---

## 3. 代码结构

核心逻辑位于 `memos/src/memos/mem_chat/` 下。

*   **`simple.py`**: **默认实现 (SimpleMemChat)**。这是一个开箱即用的 REPL（Read-Eval-Print Loop）实现，包含了完整的“检索 -> 生成 -> 存储”闭环逻辑。
*   **`base.py`**: **接口定义 (BaseMemChat)**。定义了 MemChat 的基本行为，如 `run()` 和 `mem_cube` 属性。
*   **`factory.py`**: **工厂类**。负责根据配置 (`MemChatConfig`) 实例化具体的 MemChat 对象。

---

## 4. 关键接口

主要的交互入口是 `MemChat` 类（通常由 `MemChatFactory` 创建）。

### 4.1 初始化
你需要先创建一个配置对象，然后通过工厂方法创建实例。创建后，必须将 `MemCube` 实例挂载到 `mem_chat.mem_cube` 上。

### 4.2 `run()`
启动一个交互式的命令行对话循环。适合开发调试，它会处理用户输入、调用记忆检索、生成回复并打印。

### 4.3 属性
*   **`mem_cube`**: 关联的记忆立方体对象。MemChat 通过它来读写记忆。
*   **`chat_llm`**: 用于生成回复的 LLM 实例。

---

## 5. 工作流程

MemChat 的一轮对话循环通常包含以下步骤：

1.  **接收输入 (Input)**: 获取用户的文本输入。
2.  **记忆检索 (Recall)**: (如果开启 `enable_textual_memory`) 使用用户输入作为 Query，从 `mem_cube.text_mem` 中检索 Top-K 条相关记忆。
3.  **构建提示词 (Prompt Construction)**: 将系统提示词、检索到的记忆、最近的对话历史 (History) 拼接成完整的 Prompt。
4.  **生成回复 (Generation)**: 调用 `chat_llm` 生成回复。
5.  **记忆提取与存储 (Memorization)**: (如果开启 `enable_textual_memory`) 将本轮对话 (User + Assistant) 发送给 `mem_cube` 的提取器，提取新记忆并存入数据库。

---

## 6. 开发示例

下面是一个完整的代码示例，展示了如何配置 MemChat，并挂载一个基于 Qdrant 和 OpenAI 的 MemCube。

### 6.1 代码实现

```python
import os
import sys

# 确保 src 模块可以被导入
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../src")))

from memos.configs.mem_chat import MemChatConfigFactory
from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.mem_chat.factory import MemChatFactory
from memos.mem_cube.general import GeneralMemCube

def get_mem_chat_config() -> MemChatConfigFactory:
    """生成 MemChat 配置"""
    return MemChatConfigFactory.model_validate(
        {
            "backend": "simple",
            "config": {
                "user_id": "user_123",
                "chat_llm": {
                    "backend": "openai",
                    "config": {
                        "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o"),
                        "temperature": 0.8,
                        "max_tokens": 1024,
                        "api_key": os.getenv("OPENAI_API_KEY"),
                        "api_base": os.getenv("OPENAI_API_BASE"),
                    },
                },
                "max_turns_window": 20,
                "top_k": 5,
                "enable_textual_memory": True, # 开启显式记忆
            },
        }
    )

def get_mem_cube_config() -> GeneralMemCubeConfig:
    """生成 MemCube 配置"""
    return GeneralMemCubeConfig.model_validate(
        {
            "user_id": "user03alice",
            "cube_id": "user03alice/mem_cube_tree",
            "text_mem": {
                "backend": "general_text",
                "config": {
                    "cube_id": "user03alice/mem_cube_general",
                    "extractor_llm": {
                        "backend": "openai",
                        "config": {
                            "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o"),
                            "api_key": os.getenv("OPENAI_API_KEY"),
                            "api_base": os.getenv("OPENAI_API_BASE"),
                        },
                    },
                    "vector_db": {
                        "backend": "qdrant",
                        "config": {
                            "collection_name": "user03alice_mem_cube_general",
                            "vector_dimension": 1024,
                        },
                    },
                    "embedder": {
                        "backend": os.getenv("MOS_EMBEDDER_BACKEND", "universal_api"),
                        "config": {
                            "provider": "openai",
                            "api_key": os.getenv("MOS_EMBEDDER_API_KEY", "EMPTY"),
                            "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "bge-m3"),
                            "base_url": os.getenv("MOS_EMBEDDER_API_BASE"),
                        },
                    },
                },
            },
        }
    )

def main():
    print("Initializing MemChat...")
    mem_chat = MemChatFactory.from_config(get_mem_chat_config())

    print("Initializing MemCube...")
    mem_cube = GeneralMemCube(get_mem_cube_config())

    # 关键步骤：挂载记忆立方体
    mem_chat.mem_cube = mem_cube

    print("Starting Chat Session...")
    try:
        mem_chat.run()
    finally:
        print("Saving memory cube...")
        mem_chat.mem_cube.dump("new_cube_path")

if __name__ == "__main__":
    main()
```

---

## 7. 配置说明

在配置 `MemChatConfigFactory` 时，以下参数至关重要：

*   **`user_id`**: 必填。用于标识当前对话的用户，确保记忆的隔离性。
*   **`chat_llm`**: 对话模型配置。建议使用能力较强的模型（如 GPT-4o），以获得更好的回复质量和指令遵循能力。
*   **`enable_textual_memory`**: `True` / `False`。是否开启文本记忆。如果开启，系统会在对话前进行检索，并在对话后进行存储。
*   **`max_turns_window`**: 整数。对话历史保留的轮数。超过此限制的历史记录将被截断，从而依赖长期记忆来补充上下文。
*   **`top_k`**: 整数。每次从记忆库中检索多少条最相关的记忆片段注入到 Prompt 中。
