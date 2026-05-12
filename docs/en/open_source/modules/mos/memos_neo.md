---
title: MemOS NEO Version
desc: Get up and running with MemOS in minutes using `MOS.simple()` - the fastest way to start building memory-enhanced applications.
---

## Quick Setup

### Environment Variables

Set your API credentials:

```bash
export OPENAI_API_KEY="sk-your-api-key-here"
export OPENAI_API_BASE="https://api.openai.com/v1"  # Optional
export MOS_TEXT_MEM_TYPE="general_text"  #or "tree_text" for advanced

#tips: general_text only support one-user when init MOS
```

### One-Line Setup

```python
from memos.mem_os.main import MOS

# Auto-configured instance
memory = MOS.simple()
```
::note
**Warning:**<br>The `MOS.simple()` will use deafult embedding model and size text-embedding-3-large dim-size 3027 if you had use other version memos before, you need delete dir ~/.memos for new qdrant or drop neo4j db
::

## Basic Usage

```python
#!/usr/bin/env python3
import os
from memos.mem_os.main import MOS

# Set environment variables
os.environ["OPENAI_API_KEY"] = "sk-your-api-key"
os.environ["MOS_TEXT_MEM_TYPE"] = "general_text"

# Create memory system
memory = MOS.simple()

# Add memories
memory.add("My favorite color is blue")
memory.add("I work as a software engineer")
memory.add("I live in San Francisco")

# Chat with memory context
response = memory.chat("What is user favorite color?")
print(response)  # "favorite color is blue!"

response = memory.chat("Tell me about user job and location")
print(response)  # Uses stored memories to respond
```

## Memory Types

### General Text Memory (Recommended for Beginners)
- **Storage**: Local JSON files + Qdrant vector database
- **Setup**: No external dependencies
- **Best for**: Most use cases, quick prototyping

```bash
export MOS_TEXT_MEM_TYPE="general_text"
```

### Tree Text Memory (Advanced)
- **Storage**: Neo4j graph database
- **Setup**: Requires Neo4j server
- **Best for**: Complex relationship reasoning

```bash
export MOS_TEXT_MEM_TYPE="tree_text"
export NEO4J_URI="bolt://localhost:7687"  # Optional
export NEO4J_PASSWORD="your-password"     # Optional
```

## Neo version Overview

`MOS.simple()` automatically creates a complete configuration using sensible defaults:

### Default Settings
- **LLM**: GPT-4o-mini with temperature 0.8
- **Embedder**: OpenAI text-embedding-3-large
- **Chunking**: 512 tokens with 128 overlap
- **Graph-DB**: graph db for neo4j

### Default Configuration Utilities

MemOS provides three main configuration utilities in `default_config.py`:

- **`get_default_config()`**: Creates complete MOS configuration with sensible defaults
- **`get_default_cube_config()`**: Creates MemCube configuration for memory storage
- **`get_default()`**: Returns both MOS config and MemCube instance together

```python
from memos.mem_os.utils.default_config import get_default, get_default_cube_config

# Get both MOS config and MemCube instance
mos_config, default_cube = get_default(
    openai_api_key="sk-your-key",
    text_mem_type="general_text"
)

# Or create just MemCube config
cube_config = get_default_cube_config(
    openai_api_key="sk-your-key",
    text_mem_type="general_text"
)
```

### Manual Configuration (Optional)

If you need more control, use the configuration utilities:

```python
from memos.mem_os.main import MOS
from memos.mem_os.utils.default_config import get_default_config

# Custom configuration
config = get_default_config(
    openai_api_key="sk-your-key",
    text_mem_type="general_text",
    user_id="my_user",
    model_name="gpt-4",           # Different model
    temperature=0.5,              # Lower creativity
    chunk_size=256,               # Smaller chunks
    top_k=10                      # More search results
)

memory = MOS(config)
```

### Advanced Features

Enable additional capabilities:

```python
config = get_default_config(
    openai_api_key="sk-your-key",
    enable_activation_memory=True,    # KV-cache memory
    enable_mem_scheduler=True,        # Background processing
)
```


## Other Tips

1. **Start Simple**: Use `general_text` memory type initially
2. **Environment Setup**: Keep API keys in environment variables
3. **Memory Quality**: Add specific, factual information for best results
4. **Batch Operations**: Add multiple related memories together
5. **User Context**: Use `user_id` parameter for multi-user scenarios only for `tree_text`

## Troubleshooting

### Common Issues

**Missing API Key Error**:
```bash
# Ensure environment variable is set
echo $OPENAI_API_KEY
```

**Neo4j Connection Error** (tree_text mode):
```bash
# Check Neo4j is running desktop for local user or enterprise neo4j
```
