---
title: 对话
desc: 集成“检索、生成、存储”全链路的 RAG 闭环接口，支持基于 MemCube 的个性化回复与记忆自动沉淀。
---

:::note
有关API字段、格式等信息的完整列表，详见[Chat 接口文档](/api_docs/chat/chat)。
:::

**接口路径**：
* **全量响应**：`POST /product/chat/complete`
* **流式响应 (SSE)**：`POST /product/chat/stream`

**功能描述**：本接口是 MemOS 的核心业务编排入口。它能够自动从指定的 `readable_cube_ids` 中召回相关记忆，结合当前语境生成回复，并可选地将对话结果自动回写至 `writable_cube_ids` 中，实现 AI 应用的自我进化。


## 1. 核心架构：ChatHandler 编排流程

1. **记忆检索 (Retrieval)**：根据 `readable_cube_ids` 调用 **SearchHandler**，从隔离的 Cube 中提取相关的事实、偏好及工具背景。
2. **上下文增强生成 (Generation)**：将检索到的记忆片段注入 Prompt，调用指定的 LLM（通过 `model_name_or_path`）生成针对性回复。
3. **记忆自动闭环 (Storage)**：若开启 `add_message_on_answer=true`，系统会调用 **AddHandler** 将本次对话异步存入指定的 Cube，无需开发者手动调用添加接口。
## 2. 关键接口参数

### 2.1 身份与语境
| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`query`** | `str` | 是 | 用户当前的提问内容。 |
| **`user_id`** | `str` | 是 | 用户唯一标识，用于鉴权与数据隔离。 |
| `history` | `list` | 否 | 短期历史对话记录，用于维持当前会话的连贯性。 |
| `session_id` | `str` | 否 | 会话 ID。作为“软信号”提升该会话内相关记忆的召回权重。 |

### 2.2 MemCube 读写控制
| 参数名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **`readable_cube_ids`** | `list` | - | **读：** 允许检索的记忆 Cube 列表（可跨个人库与公共库）。 |
| **`writable_cube_ids`** | `list` | - | **写：** 对话完成后，自动生成的记忆应存入的目标 Cube 列表。 |
| **`add_message_on_answer`** | `bool` | `true` | 是否开启自动回写。建议开启以维持记忆的持续更新。 |

### 2.3 算法与模型配置
| 参数名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `mode` | `str` | `fast` | 检索模式：`fast` (快速), `fine` (精细), `mixture` (混合)。 |
| `model_name_or_path` | `str` | - | 指定使用的 LLM 模型名称或路径。 |
| `system_prompt` | `str` | - | 覆盖默认的系统提示词。 |
| `temperature` | `float` | - | 采样温度，控制生成文本的创造性。 |
| `threshold` | `float` | `0.5` | 记忆召回的相关性阈值，低于该值的记忆将被剔除。 |

## 3. 工作原理

MemOS提供两种响应模式可供选型：
### 3.1 全量响应 (`/complete`)
* **特点**：等待模型生成全部内容后一次性返回 JSON。
* **场景**：非交互式任务、后台逻辑处理、或对实时性要求较低的简单应用。

### 3.2 流式响应 (`/stream`)
* **特点**：采用 **Server-Sent Events (SSE)** 协议，实时推送 Token。
* **场景**：聊天机器人、智能助手等需要即时打字机反馈效果的 UI 交互。

## 4. 快速上手

推荐使用开源版内置的 `MemOSClient` 进行调用。以下示例展示了如何询问关于 R 语言学习的建议，并利用记忆功能：

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# 发起对话请求
res = client.chat(
    user_id="dev_user_01",
    query="根据我之前的偏好，推荐一套 R 语言数据清理方案",
    readable_cube_ids=["private_cube_01", "public_kb_r_lang"], # 读：个人偏好+公共库
    writable_cube_ids=["private_cube_01"],                      # 写：沉淀至个人空间
    add_message_on_answer=True,                                 # 开启自动记忆回写
    mode="fine"                                                 # 使用精细检索模式
)

if res:
    print(f"AI 回复内容: {res.data}")
```


:::note
**开发者提示：**
若需要针对 `Playground` 环境进行调试，请访问专用的调试流接口 /product/chat/stream/playground 。
:::
