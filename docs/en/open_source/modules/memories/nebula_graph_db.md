---
title: NebulaGraph-Based Plaintext Memory Backend
desc: This module provides graph-based memory storage and querying
  capabilities based on **NebulaGraph** for memory-augmented systems such as RAG pipelines, cognitive agents, or personal assistants. It inherits from `BaseGraphDB`, supports multi-user isolation, structured search, external vector indexing, and is well-suited for large-scale graph construction and reasoning.
---

## Why Choose NebulaGraph?

* Designed for large-scale distributed deployment
* Flexible support for labels and properties on both nodes and edges
* Built-in vector index support (starting from Nebula 5)

## Recommended Configuration Template

Ideal for production environments with multi-tenant isolation support:

```json
"graph_db": {
  "backend": "nebular",
  "config": {
    "uri": ["localhost:9669"],
    "user": "root",
    "password": "your_password",
    "space": "database_name",
    "user_name": "user_name",
    "use_multi_db": false,
    "auto_create": true,
    "embedding_dimension": 1024
  }
}
```

* `space`: The Nebula graph space name, equivalent to a database
* `user_name`: Used for logical isolation between users (automatically added as a filter condition)
* `embedding_dimension`: Should match your embedding model (e.g., `text-embedding-3-large` = 3072)
* `auto_create`: Whether to automatically create the graph space and schema (recommended for testing)

## Multi-Tenant Usage Patterns

The NebulaGraph backend supports two multi-tenant architectures:

### Shared DB with Logical User Isolation (`user_name`)

Best for scenarios where multiple users or agents share one graph space with logical separation:

```python
GraphDBConfigFactory(
  backend="nebular",
  config={
    "space": "shared_graph",
    "user_name": "alice",
    "use_multi_db": False,
    ...
  },
)
```

### Dedicated DB per User (Multi-DB)

Recommended for stronger resource isolation. Each user has their own dedicated graph space:

```python
GraphDBConfigFactory(
  backend="nebular",
  config={
    "space": "user_alice_graph",
    "use_multi_db": True,
    "auto_create": True,
    ...
  },
)
```

## Quick Usage Example

```python
import os
import json
from memos.graph_dbs.factory import GraphStoreFactory
from memos.configs.graph_db import GraphDBConfigFactory

config = GraphDBConfigFactory(
    backend="nebular",
    config={
        "uri": json.loads(os.getenv("NEBULAR_HOSTS", "localhost")),
        "user": os.getenv("NEBULAR_USER", "root"),
        "password": os.getenv("NEBULAR_PASSWORD", "xxxxxx"),
        "space": os.getenv("space"),
        "use_multi_db": True,
        "auto_create": True,
        "embedding_dimension": os.getenv("embedding_dimension", 1024),
    },
)

graph = GraphStoreFactory.from_config(config)

topic = TextualMemoryItem(
    memory="This research addresses long-term multi-UAV navigation for energy-efficient communication coverage.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        key="Multi-UAV Long-Term Coverage",
        hierarchy_level="topic",
        type="fact",
        memory_time="2024-01-01",
        source="file",
        sources=["paper://multi-uav-coverage/intro"],
        status="activated",
        confidence=95.0,
        tags=["UAV", "coverage", "multi-agent"],
        entities=["UAV", "coverage", "navigation"],
        visibility="public",
        updated_at=datetime.now().isoformat(),
        embedding=embed_memory_item(
            "This research addresses long-term "
            "multi-UAV navigation for "
            "energy-efficient communication "
            "coverage."
        ),
    ),
)

graph.add_node(
    id=topic.id, memory=topic.memory, metadata=topic.metadata.model_dump(exclude_none=True)
)
```
