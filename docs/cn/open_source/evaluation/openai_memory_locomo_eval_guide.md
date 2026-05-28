# OpenAI Memory on LoCoMo - 评测指南

本文档介绍如何使用 LoCoMo 数据集对 OpenAI 的 Memory 能力进行评测。

## 1. 简介

由于 OpenAI 的 [Memory 功能](https://openai.com/index/memory-and-new-controls-for-chatgpt/) 目前没有公开的 API，因此评测过程需要一定的人工操作。我们会将 LoCoMo 数据集中的对话整理成特定格式，手动输入到 ChatGPT 网页界面中。随后，从账户的记忆管理页面中导出生成的记忆条目，并保存到本地。

为了评估这些记忆的质量，我们会通过 API 使用 `gpt-4o-mini` 模型来回答 LoCoMo 数据集中的问题，同时把对应对话的全部记忆作为上下文提供给模型。这样可以模拟一个“完美的记忆检索系统”，让模型在回答问题时拥有尽可能完整的信息。

## 2. 步骤化工作流

### 步骤 2.1：为记忆抽取生成输入上下文

运行下面的 Python 脚本，为每段对话中的每个 session 生成输入提示。脚本会为每个 session 单独生成一个 `.txt` 文件，其中包含格式化后的对话历史与抽取提示。

**脚本：**
```python
import json
import os

# Ensure the path to the dataset is correct
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

### 步骤 2.2：从 ChatGPT 中抽取并保存记忆

1.  **启用 Memory：** 在 ChatGPT 中进入 **Settings -> Personalization**，确保 **Memory** 已开启。
2.  **清空已有记忆：** 在处理一段新对话之前，点击 **Manage** 并执行 **Clear all**，以保证从空白状态开始。
3.  **输入并验证：**
    * 打开一个新的对话窗口。
    * 确保使用的模型为 **GPT-4o**。
    * 复制生成的 `.txt` 文件内容（例如 `0-D1.txt`），并将其粘贴到对话框中。
    * 在模型回复之后，请确认界面上出现了 “Memory updated” 提示。
4.  **保存记忆：**
    * 点击 Memory 提示中的 **Manage**，查看新生成的记忆条目。
    * 在本地新建一个与输入文件同名的 `.txt` 文件（例如 `0-D1.txt`）。
    * 将 ChatGPT 中每一条记忆复制并粘贴到这个新文件中，每条记忆占一行。
5.  **为下一段对话重置记忆：**
    * 当某段对话的所有 session 都处理完成后，**务必删除全部记忆，以便下一段对话从干净的状态开始**。请依次进入 Settings -> Personalization -> Manage，然后点击 Delete all。

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

上一步保存的记忆是按 session 分文件存放的。你需要编写一个简单的脚本，将属于同一段对话的所有记忆合并到一个文件中。例如，将 `0-D1.txt`、`0-D2.txt` 等所有文件中的记忆合并为一个 `conversation_0_memories.txt`。


### 步骤 2.4：自动化评测

当所有对话的记忆都抽取并保存完毕后，就可以运行自动化的 [评测脚本](../../../../evaluation/scripts/run_openai_eval.sh)。该脚本会负责生成答案、对答案进行评估并计算指标。

```bash
# 在 evaluation/scripts/run_openai_eval.sh 中修改配置
evaluation/scripts/run_openai_eval.sh
```

## 3. 注意事项

-   **账户差异：** 请留意免费账户与 Plus 账户之间可能存在的差异，例如上下文长度限制和可存储记忆数量上限等。
-   **记忆粒度：** 本评测流程是以 session 为单位添加记忆的。为了获得高质量的记忆抽取效果，建议你也遵循同样的粒度。实践表明，把整段对话一次性输入模型的效果并不理想，模型常常会忽略重要细节，导致信息显著丢失。
