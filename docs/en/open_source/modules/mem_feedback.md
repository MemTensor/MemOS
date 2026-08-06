---
title: MemFeedback
desc: MemFeedback is your "memory error notebook". It enables your Agent to understand 'You remembered it wrong' and automatically correct the memory database. It is a key component for achieving self-evolving memory.
---

## 1. Introduction

**MemFeedback** is the "regret medicine" for MemOS.

In long-term memory systems, the biggest headache is often not "forgetting," but "remembering wrong and unable to change." When a user says, "No, my birthday is tomorrow" or "Change the project code to X," simple RAG systems are usually helpless.

MemFeedback can understand these natural language instructions, automatically locate conflicting memories in the database, and execute atomic correction operations (such as archiving old memories and writing new ones). With it, your Agent can correct errors and learn continuously during interactions, just like a human.

---

## 2. Core Capabilities

It can handle four common feedback scenarios:

### Correction
When the user points out a factual error. The system will not brutally delete the old data but **Archive** it and write new data. This corrects the error while preserving version history (Traceability). If it is an ongoing conversation (WorkingMemory), it updates in place to ensure context continuity.

### Addition
If the user just supplements new information that does not conflict with old memories, it is simple—directly save it as a new node in the memory database.

### Keyword Replacement (Global Refactor)
Similar to "Global Refactor" in an IDE. For example, if the user says, "Change 'Zhang San' to 'Li Si' in all documents," the system will combine the Reranker to automatically determine the scope of affected documents and update all relevant memories in batches.

### Preference Evolution
Specifically handles preferences like "I don't eat cilantro" or "I like Python." The system records the context in which this preference arose, constantly enriching the user profile to make the Agent more tailored to use.

---

## 3. Code Structure

The core logic is located under `memos/src/memos/mem_feedback/`.

*   **`simple_feedback.py`**: **Recommended entry point**. It is the official encapsulated version that assembles LLM, vector database, and searcher, ready to use out of the box.
*   **`feedback.py`**: Core implementation class `MemFeedback`. The heavy lifting is done here: intent recognition, conflict comparison, and security risk control.
*   **`base.py`**: Interface definition.
*   **`utils.py`**: Utility box.

---

## 4. Key Interface

There is only one main entry point: `process_feedback()`. It is usually called asynchronously after the RAG process ends and the user gives feedback.

### 4.1 Input Parameters

| Parameter | Description |
| :--- | :--- |
| `user_id` / `user_name` | User identification and Cube ID. |
| `chat_history` | Conversation history, letting LLM know what you talked about. |
| `feedback_content` | The feedback sentence from the user (e.g., "No, it's 5 o'clock"). |
| **`retrieved_memory_ids`** | **Required (Strongly Recommended)**. Pass in the memory IDs retrieved in the previous RAG round. This gives the system a "target," telling it which memory to correct. If not passed, the system has to search again in the massive memory, which is slow and prone to errors. |
| `corrected_answer` | Whether to generate a corrected response along the way. |

### 4.2 Output Result

Returns a dictionary telling you what changed in this operation:
*   **`record`**: Database change details (e.g., `{ "add": [...], "update": [...] }`).
*   **`answer`**: Natural language response to the user.

---

## 5. Workflow

The workflow of MemFeedback is like a rigorous editorial office:

1.  **Review (Intent Recognition)**: First, see if the user is correcting errors, adding information, or renaming.
2.  **Locate (Recall)**: Find the memory to be modified (if you passed the ID, this step is skipped).
3.  **Proofread (Comparison)**: Let LLM carefully compare new and old information to determine if it is completely new (ADD) or needs an update (UPDATE).
4.  **Risk Control (Security Check)**: Prevent LLM from making random changes. For example, is the ID correct? Is it trying to delete an entire long document? (Threshold interception applies).
5.  **Publish (Write)**: Finally, execute graph database operations, archive the old, and write the new.

---

## 6. Development Example

Here is a runnable code snippet showing how to initialize the service, preset an "incorrect memory," and then correct it through user feedback.

### 6.1 Preparation

First, we need to initialize the `SimpleMemFeedback` service.

```python
# Assuming components like llm, embedder, graph_db are initialized via Factory
# For complete initialization code, please refer to examples/mem_feedback/example_feedback.py

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

### 6.2 Simulate Scenario and Execute Feedback

Scenario: The system incorrectly remembers "You like apples, dislike bananas," and now we want to correct it.

```python
import json
from memos.mem_feedback.utils import make_mem_item

# 1. Simulate Chat History
# User asks for preference, assistant answers wrongly
history = [
    {"role": "user", "content": "What fruits do I like and dislike?"},
    {"role": "assistant", "content": "You like apples, dislike bananas."},
]

# 2. Preset "Incorrect Memory"
# We manually insert an incorrect fact into the database
mem_text = "You like apples, dislike bananas"
# ... (Omitted detailed parameters of make_mem_item, see source code) ...
memory_manager.add([make_mem_item(mem_text, ...)], ...)

# 3. User Feedback
feedback_content = "Wrong, actually I like mangosteens."
print(f"Feedback Input: {feedback_content}")

# 4. Execute Correction
# MemFeedback will detect conflict, archive old memory, and write new memory "like mangosteens"
res = feedback_server.process_feedback(
    ...,
    chat_history=history,
    feedback_content=feedback_content,
    ...
)

# 5. View Result
print(json.dumps(res, indent=4))
```

---

## 7. Configuration Description

To make MemFeedback work, you need to prepare the configuration of the following components (usually in `.env` or YAML):

*   **LLM (`extractor_llm`)**: Needs a smart brain, recommend GPT-4o level models. Set Temperature low (e.g., 0) because it performs logical analysis and shouldn't be too divergent.
*   **Embedder (`embedder`)**: Used to convert new memories into vectors.
*   **GraphDB (`graph_db`)**: Where memories are stored and how, handled by these two.
*   **MemReader (`mem_reader`)**: Used to parse purely new memories.
