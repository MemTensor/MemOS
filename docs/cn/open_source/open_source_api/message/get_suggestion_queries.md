---
title: 获取建议问题 (Get Suggestions)
desc: 基于当前对话语境或 Cube 内的近期记忆，自动生成 3 条后续对话建议。
---

**接口路径**：`POST /product/suggestions`
**功能描述**：本接口用于实现“猜你想问”功能。系统会根据提供的对话上下文或目标 **MemCube** 中的近期记忆，通过大语言模型生成 3 个相关的建议问题，帮助用户延续对话。

## 1. 核心机理：双模式生成策略

**SuggestionHandler** 根据入参的不同，支持两种灵活的生成模式：

* **基于对话的即时建议 (Context-based)**：
    * **触发条件**：在请求中提供了 `message`（对话记录）。
    * **逻辑**：系统分析最近的对话内容，生成 3 个与当前话题紧密相关的后续问题。
* **基于记忆的发现建议 (Memory-based)**：
    * **触发条件**：未提供 `message`。
    * **逻辑**：系统会从 `mem_cube_id` 指定的记忆体中检索“最近记忆”，并据此生成与用户近期生活、工作状态相关的启发式问题。



## 2. 关键接口参数

核心参数定义如下：

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | 是 | - | 用户唯一标识符。 |
| **`mem_cube_id`** | `str` | 是 | - | **核心参数**：指定建议生成所依据的记忆空间。 |
| **`language`** | `str` | 否 | `zh` | 生成建议使用的语言：`zh` (中文) 或 `en` (英文)。 |
| `message` | `list/str`| 否 | - | 当前对话上下文。若提供，则生成基于对话的建议。 |

## 3. 工作原理 (SuggestionHandler)

1. **语境识别**：`SuggestionHandler` 首先检查 `message` 字段。若有值，则提取对话精髓；若为空，则转向底层 `MemCube` 获取最近动态。
2. **模板匹配**：系统根据 `language` 参数自动切换内置的中英文提示词模板（Prompt Templates）。
3. **模型推理**：调用 LLM 对背景资料进行推导，确保生成的 3 个问题既符合逻辑又具有启发性。
4. **格式化输出**：将建议问题以数组形式返回，便于前端直接渲染为点击按钮。

## 4. 快速上手示例

使用 HTTP 请求获取针对当前对话的中文建议：

```python
import requests

# 场景：根据刚刚关于”R语言”的对话生成建议
res = requests.post(
    “http://localhost:8000/product/suggestions”,
    json={
        “user_id”: “dev_user_01”,
        “mem_cube_id”: “private_cube_01”,
        “language”: “zh”,
        “message”: [
            {“role”: “user”, “content”: “我想学习 R 语言的可视化。”},
            {“role”: “assistant”, “content”: “推荐您学习 ggplot2 包，它是 R 语言可视化的核心工具。”}
        ]
    }
)

if res.status_code == 200:
    data = res.json()
    # 示例输出: [“如何安装 ggplot2？”, “有哪些经典的 ggplot2 教程？”, “R 语言还有哪些可视化包？”]
    print(f”建议问题: {data['data']}”)
```

## 5. 使用场景建议
对话引导：在 AI 回复完用户后，自动调用此接口，在回复框下方展示建议按钮，引导用户深入探讨。

冷启动激活：当用户进入一个新的会话且尚未发言时，通过“基于记忆模式”展示用户可能感兴趣的往期话题，打破沉默。
