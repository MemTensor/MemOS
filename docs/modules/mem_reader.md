# Getting Started with MemReader

This guide walks you through how to use the `SimpleStructMemReader` to extract structured memories from conversations and documents using LLMs and embedding models. It is ideal for building memory-aware conversational AI, knowledge bases, and semantic search systems.

---

##  Initialize a `SimpleStructMemReader`

First, configure and initialize the reader with your preferred LLM and embedder models.

### Example:

```python
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.mem_reader.simple_struct import SimpleStructMemReader
reader_config = SimpleStructMemReaderConfig.from_json_file(
    "examples/data/config/simple_struct_reader_config.json"
)
reader = SimpleStructMemReader(reader_config)
```
::tip
You can customize the model names or backends depending on your environment.
::
---

## Get Your First Chat Memory

Extract structured memories from a conversation between a user and assistant.

### Example Input:

```python
conversation_data = [
    [
        {"role": "user", "content": "I have a meeting tomorrow at 3 PM"},
        {"role": "assistant", "content": "What's the meeting about?"},
        {"role": "user", "content": "It's about the Q4 project deadline"}
    ]
]
```

### Extract Memories:

```python
memories = reader.get_memory(
    conversation_data,
    type="chat",
    info={"user_id": "user_001", "session_id": "session_001"}
)
```

### Sample Output:

```json
[
    TextualMemoryItem(
        id='2d5965f9-4c9b-4c24-9068-325b53db098b',
        memory='Tomorrow at 3:00 PM, the user will meet with the Q4 project team to discuss the deadline.',
        metadata=TreeNodeTextualMemoryMetadata(
            user_id='user_001',
            session_id='session_001',
            status='activated',
            type='fact',
            confidence=0.99,
            tags=['deadline', 'project'],
            visibility=None,
            updated_at='2025-07-03T14:34:33.535844',
            memory_type='UserMemory',
            key='Meeting schedule',
            sources=[
                "user: I have a meeting tomorrow at 3 PM",
                "assistant: What's the meeting about?",
                "user: It's about the Q4 project deadline"
            ],
            embedding=[0.0058597163, ..., 0.009375607],
            created_at='2025-07-03T14:34:33.535860',
            usage=[],
            background="The user plans to meet with the Q4 project team tomorrow at 3:00 PM to address the project's deadline. This action reflects their proactive approach to managing project timelines and their focus on ensuring timely completion."
        )
    )
]
```
::note
The reader extract related memories and tags from the conversation session.
::
---

## Get Your First Document Memory

Process text files to extract structured summaries and tags.

### Example Code:

```python
doc_paths = [
    "examples/mem_reader/text1.txt",
    "examples/mem_reader/text2.txt",
]

doc_memories = reader.get_memory(
    doc_paths,
    type="doc",
    info={
        "user_id": "user_001",
        "session_id": "session_001",
        "chunk_size": 512,
        "chunk_overlap": 128
    }
)
```

### Sample Output:

```json
[
    TextualMemoryItem(
        id='24dabd9f-200b-40c4-84cc-2c0fccaaf8fd',
        memory='This is another sample document content for testing purposes.',
        metadata=TreeNodeTextualMemoryMetadata(
            user_id='user_001',
            session_id='session_001',
            status='activated',
            type='fact',
            memory_time=None,
            source=None,
            confidence=0.99,
            entities=None,
            tags=['Testing', 'Sample'],
            visibility=None,
            updated_at='2025-07-03T14:38:29.776147',
            memory_type='LongTermMemory',
            key='',
            sources=['examples/mem_reader/text2.txt_0'],
            embedding=[0.028731367, ..., -0.018501928],
            created_at='2025-07-03T14:38:29.776213',
            usage=[],
            background=''
        )
    )
]
```
::note
Documents are chunked and summarized to create searchable knowledge items.
::

### Supported Files

We use [`markitdown`](https://github.com/microsoft/markitdown) to convert files to Markdown format texts.

**MarkItDown currently supports the conversion from:**

```
PDF
PowerPoint
Word
Excel
Images (EXIF metadata and OCR)
Audio (EXIF metadata and speech transcription)
HTML
Text-based formats (CSV, JSON, XML)
ZIP files (iterates over contents)
YouTube URLs
EPUBs
... and more!
```
*(Content sourced from [MarkItDown GitHub repository](https://github.com/microsoft/markitdown))*

---


## Try It Out: Print Extracted Memories

```python
for memory_list in memories:
    for memory_item in memory_list:
        print("🧠 Memory:", memory_item.memory)
        print("🏷 Tags:", memory_item.metadata.tags)
        print("👤 User ID:", memory_item.metadata.user_id)
        print("📅 Created At:", memory_item.metadata.created_at)
        print("---")
```

---

You’ve now successfully:
- Initialized a `SimpleStructMemReader`
- Extracted structured memories from chat conversations
- Extracted knowledge from documents
