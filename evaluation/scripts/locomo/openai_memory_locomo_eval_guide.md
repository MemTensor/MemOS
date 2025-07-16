# OpenAI Memory on LoCoMo - Evaluation Guide

This document outlines the evaluation process for OpenAI's Memory feature using the LoCoMo dataset.

## 1. Introduction

Since OpenAI's [Memory feature](https://openai.com/index/memory-and-new-controls-for-chatgpt/) does not have a public API, the evaluation requires a manual process. Dialogues from the LoCoMo dataset are formatted and manually input into the ChatGPT web interface. The resulting memories are then retrieved from the account's memory management page and saved locally.

To evaluate the quality of these memories, we will use the `gpt-4o-mini` model via API. The model will be asked questions from the LoCoMo dataset, and the full history of memories for the relevant conversation will be provided as context. This simulates a perfect memory retrieval system, giving the model the best possible information to answer the question.

## 2. Step-by-Step Workflow

### Step 2.1: Generate Input Context for Memory Extraction

Run the following Python script to generate the input prompts for each session in each conversation. The script will create a separate `.txt` file for each session, containing the formatted conversation history and the extraction prompt.

**Script:**
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

**Example Input (`0-D9.txt`):**
```plaintext
Can you please extract relevant information from this conversation and create memory entries for each user mentioned? Please store these memories in your knowledge base in addition to the timestamp provided for future reference and personalized interactions.

(2:31 pm on 17 July, 2023) Melanie: Hey Caroline, hope all's good! I had a quiet weekend after we went camping with my fam two weekends ago. It was great to unplug and hang with the kids. What've you been up to? Anything fun over the weekend?
(2:31 pm on 17 July, 2023) Caroline: Hey Melanie! That sounds great! Last weekend I joined a mentorship program for LGBTQ youth - it's really rewarding to help the community.
... (rest of the conversation)
```

### Step 2.2: Extract and Save Memories from ChatGPT

1.  **Enable Memory:** In ChatGPT, go to **Settings -> Personalization** and ensure **Memory** is turned on.
2.  **Clear Existing Memories:** Before processing a new conversation, click on **Manage** and **Clear all** to ensure a clean slate.
3.  **Input and Verify:**
    * Open a new chat.
    * Ensure the model is set to **GPT-4o**.
    * Copy the content of a generated `.txt` file (e.g., `0-D1.txt`) and paste it into the chat.
    * After the model responds, verify that you see the "Memory updated" confirmation.
4.  **Save Memories:**
    * Click on **Manage** in the memory confirmation to view the newly generated memories.
    * Create a new local `.txt` file with the same name as the input file (e.g., `0-D1.txt`).
    * Copy each memory entry from ChatGPT and paste it into the new file, with each memory on a new line.
5.  **Reset Memories for the Next Conversation:**
    * Once all sessions for a conversation are complete, it is essential to **delete all memories to ensure a clean state for the next conversation**. Navigate to Settings -> Personalization -> Manage and click Delete all.

**Example Memory Output (`0-D9.txt`):**
```plaintext
As of November 17, 2023, Dave has taken up photography and enjoys capturing nature scenes like sunsets, beaches, waves, rocks, and waterfalls.
Dave recently purchased a vintage camera that takes high-quality photos.
Dave discovered a serene park nearby with a peaceful spot featuring a bench under a tree with pink flowers.
As of November 17, 2023, Calvin attended a fancy gala in Boston where he had an inspiring conversation with an artist about music and art.
Calvin finds music a powerful connector and source of creativity.
Calvin took a photo in a Japanese garden that he shared with Dave.
Calvin accepted an invitation to perform at an upcoming show in Boston, expressing excitement about the musical experience.
```

### Step 2.3: Consolidate Memories

The memories are currently saved per session. You need to write a simple script to consolidate all memories belonging to the same conversation into a single file. For example, all memories from `0-D1.txt`, `0-D2.txt`, etc., should be merged into a single `conversation_0_memories.txt`.


### Step 2.4: Automated Evaluation

Once the memories for all conversations have been extracted and saved, you can run the automated [evaluation script](../run_openai_eval.sh). This script will handle the process of generating answers, evaluating them, and calculating metrics.

```bash
# Edit the configuration in ./scripts/run_openai_eval.sh
./scripts/run_openai_eval.sh
```

## 3. Considerations

-   **Account Differences:** Be aware of potential differences between free and Plus accounts, such as context length limitations and the number of memories that can be stored.
-   **Granularity:** The evaluation process adds memories at the session level. To ensure high-quality memory extraction, you should follow this same principle. Feeding the entire conversation to the model at once has been shown to be ineffective, often causing it to overlook important details and leading to substantial information loss.
