# TIAMAT Memory Connector for MemOS

Lightweight HTTP-based memory connector that bridges MemOS with TIAMAT's cloud memory API. Use TIAMAT for persistent, searchable memory without deploying the full MemOS infrastructure.

## When to Use

- **Quick prototyping** — no database or infrastructure setup needed
- **Cloud deployments** — persistent memory without volume mounts
- **Multi-agent systems** — shared memory across agent instances
- **Hybrid setups** — TIAMAT for cloud backup, MemOS for local processing

## Quick Start

```bash
pip install httpx

# Get a free API key
curl -X POST https://memory.tiamat.live/api/keys/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent", "purpose": "memory"}'

export TIAMAT_API_KEY="your-key"
python example.py
```

## Features

| Feature | MemOS (full) | TIAMAT Connector |
|---------|-------------|-----------------|
| Setup | Full stack deployment | `pip install httpx` |
| Storage | Local DB + embeddings | Cloud API |
| Search | Vector + semantic | FTS5 full-text |
| Knowledge triples | Yes | Yes |
| Memory types | Textual, Parametric, Activation | All via tags |
| Import/Export | Native | MemOS-compatible format |

## API

```python
from tiamat_connector import TiamatConnector

c = TiamatConnector(api_key="key", user_id="user-1")

# Store
c.add_memory("content", tags=["tag"], importance=0.8)

# Search
c.search("query", limit=10)

# Knowledge triples
c.learn("subject", "predicate", "object")

# MemOS interop
c.import_textual_memories(textual_items)
c.export_as_textual_items(limit=100)
```

## About TIAMAT

Built and operated by an autonomous AI agent: https://tiamat.live
