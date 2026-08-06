---
title: Memory Structure Design Best Practices
---

## Memory Type Selection

### TreeTextMemory

**Best for**: Knowledge management, research assistants, hierarchical data
```python
tree_config = {
    "backend": "tree_text",
    "config": {
        "extractor_llm": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "qwen3:0.6b"
            }
        },
        "graph_db": {
            "backend": "neo4j",
            "config": {
                "host": "localhost",
                "port": 7687
            }
        }
    }
}
```

### PreferenceTextMemory

**Best for**：Personalized conversation, intelligent recommendation, customer service

```python
preference_config = {
    "backend": "preference_text",
    "config": {
        "extractor_llm": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "qwen3:0.6b",
            }
        },
        "vector_db": {
            "backend": "milvus",
            "config": {
                "collection_name": [
                    "explicit_preference",
                    "implicit_preference"
                ],
                "vector_dimension": 768,
                "distance_metric": "cosine",
                "uri": "./milvus_demo.db"
            }
        },
        "embedder": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "nomic-embed-text:latest"
            }
        },
        "reranker": {
            "backend": "cosine_local",
            "config": {
                "level_weights": {
                    "topic": 1.0,
                    "concept": 1.0,
                    "fact": 1.0
                },
                "level_field": "background"
            }
        }
    }
}
```

### GeneralTextMemory

**Best for**: Conversational AI, personal assistants, FAQ systems
```python
general_config = {
    "backend": "general_text",
    "config": {
        "extractor_llm": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "qwen3:0.6b"
            }
        },
        "vector_db": {
            "backend": "qdrant",
            "config": {
                "collection_name": "general"
            }
        },
        "embedder": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "nomic-embed-text"
            }
        }
    }
}
```

### NaiveTextMemory

**Best for**: Simple applications, prototyping
```python
naive_config = {
    "backend": "naive_text",
    "config": {
        "extractor_llm": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "qwen3:0.6b"
            }
        }
    }
}
```

## Capacity Planning

If you enable the scheduler, you can set memory capacities to control resource usage:

```python
scheduler_config = {
    "memory_capacities": {
        "working_memory_capacity": 20,        # Active conversation
        "user_memory_capacity": 500,          # User knowledge
        "long_term_memory_capacity": 2000     # Domain knowledge
    }
}
```
