# OpenAI Memory 在 LoCoMo 上的评估指南

本文档简要概述了使用 LoCoMo 数据集对 OpenAI 的 Memory 功能进行评估的整体流程。

## 1. 简介

由于 OpenAI 的 [Memory 功能](https://openai.com/index/memory-and-new-controls-for-chatgpt/) 没有公开 API，因此评估需要手动进行。LoCoMo 数据集中的对话会被格式化并手动输入到 ChatGPT 网页界面中。生成的记忆随后从账号的记忆管理页面中获取并保存到本地。

为了评估这些记忆的质量，我们将通过 API 使用 `gpt-4o-mini` 模型。模型将被问及 LoCoMo 数据集中的问题，并提供相关对话的完整记忆历史作为上下文。这模拟了一个完美的记忆检索系统，为模型提供了最佳的回答信息。

## 2. 工作流程

### 步骤 2.1：生成用于记忆提取的输入上下文

运行以下 Python 脚本，为每个对话中的每个会话生成输入提示。该脚本将为每个会话创建一个单独的 `.txt` 文件，包含格式化的对话历史和提取提示。

**脚本：**
```python
import json
import os

# 确保数据集路径正确
LOCOMO_DATA_PATH = "data/locomo/locomo10.json"
SAVE_DIR = "openai_inputs"

os.makedirs(SAVE_DIR, exist_ok=True)

TEMPLATE = """Can you please extract relevant information from this conversation and create memory entries for each user mentioned? Please store these memories in your knowledge base in addition to the timestamp provided for future reference and personalized interactions.

{context}
"""

with open(LOCOMO_DATA_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

for conv_idx, item in enumerate(data):
    conv = item["conversation"]

    for i in range(1, 35):
        session_key = f"session_{i}"
        session_dt_key = f"session_{i}_date_time"
        if session_key not in conv:
            continue

        session = conv[session_key]
        session_dt = conv[session_dt_key]

        session_context = ""
        for chat in session:
            chat_str = f"({session_dt}) {chat['speaker']}: {chat['text']}\n"
            session_context += chat_str

        input_string = TEMPLATE.format(context=session_context)

        output_filename = os.path.join(SAVE_DIR, f"{conv_idx}-D{i}.txt")
        with open(output_filename, "w", encoding="utf-8") as f:
            f.write(input_string)

print(f"Generated {len(os.listdir(SAVE_DIR))} input files in '{SAVE_DIR}' directory.")
```

**输入示例（`0-D9.txt`）：**
```plaintext
Can you please extract relevant information from this conversation and create memory entries for each user mentioned? Please store these memories in your knowledge base in addition to the timestamp provided for future reference and personalized interactions.

(2:31 pm on 17 July, 2023) Melanie: Hey Caroline, hope all's good! I had a quiet weekend after we went camping with my fam two weekends ago. It was great to unplug and hang with the kids. What've you been up to? Anything fun over the weekend?
(2:31 pm on 17 July, 2023) Caroline: Hey Melanie! That sounds great! Last weekend I joined a mentorship program for LGBTQ youth - it's really rewarding to help the community.
... (rest of the conversation)
```

### 步骤 2.2：从 ChatGPT 中提取并保存记忆

1.  **启用记忆功能：** 在 ChatGPT 中，前往 **设置（Settings） -> 个性化（Personalization）**，确保 **记忆（Memory）** 功能已开启。
2.  **清除已有记忆：** 在处理新对话之前，点击 **管理（Manage）** -> **清除全部（Clear all）**，确保清除已有记忆。
3.  **输入并验证：**
    * 开启一个新的聊天。
    * 确保模型设置为 **GPT-4o**。
    * 复制生成的 `.txt` 文件的内容（例如 `0-D1.txt`）并粘贴到聊天中。
    * 模型回复后，确认看到"记忆已更新"(Memory updated)的提示。
4.  **保存记忆：**
    * 点击记忆确认中的 **管理(Manage)**，查看新生成的记忆。
    * 创建一个与输入文件同名的新本地 `.txt` 文件（例如 `0-D1.txt`）。
    * 从 ChatGPT 中复制每条记忆并粘贴到新文件中，每条记忆占一行。
5.  **为下一个对话重置记忆：**
    * 一个对话的所有会话完成后，务必**删除所有记忆，以确保下一个对话从干净状态开始**。前往设置(Settings) -> 个性化(Personalization) -> 管理(Manage)，点击删除全部(Delete all)。

**记忆输出示例（`0-D9.txt`）：**
```plaintext
As of November 17, 2023, Dave has taken up photography and enjoys capturing nature scenes like sunsets, beaches, waves, rocks, and waterfalls.
Dave recently purchased a vintage camera that takes high-quality photos.
Dave discovered a serene park nearby with a peaceful spot featuring a bench under a tree with pink flowers.
As of November 17, 2023, Calvin attended a fancy gala in Boston where he had an inspiring conversation with an artist about music and art.
Calvin finds music a powerful connector and source of creativity.
Calvin took a photo in a Japanese garden that he shared with Dave.
Calvin accepted an invitation to perform at an upcoming show in Boston, expressing excitement about the musical experience.
```

### 步骤 2.3：合并记忆

记忆目前按会话分别保存。你需要编写一个简单的脚本，将同一对话的所有记忆合并到一个文件中。例如，`0-D1.txt`、`0-D2.txt` 等文件中的所有记忆应合并为一个 `conversation_0_memories.txt` 文件。


### 步骤 2.4：自动化评估

所有对话的记忆提取并保存完成后，可以运行自动化[评估脚本](../../../../evaluation/scripts/run_openai_eval.sh)。该脚本将处理生成答案、评估答案和计算指标的过程。

```bash
# 编辑 evaluation/scripts/run_openai_eval.sh 中的配置
evaluation/scripts/run_openai_eval.sh
```

## 3. 注意事项

-   **账号差异：** 请注意免费账号和 Plus 账号之间可能存在差异，例如上下文长度限制和可存储的记忆数量。
-   **粒度：** 评估过程在会话级别添加记忆。为确保高质量的记忆提取，应遵循相同的原则。一次性将整个对话提供给模型已被证明效果不佳，通常会导致模型忽略重要细节，从而造成大量信息丢失。
