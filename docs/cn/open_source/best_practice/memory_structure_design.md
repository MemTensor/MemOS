---
title: 记忆结构设计最佳实践
---

## 记忆类型选择

### 树形明文记忆

**最适用于**：知识管理、研究助手、层级结构数据
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

### 偏好明文记忆

**最适用于**：个性化对话、智能推荐、客户服务

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

### 通用明文记忆（带向量索引）

**最适用于**：对话式 AI、私人助理、问答系统

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

### 纯明文记忆（仅文本）

**最适用于**：简单应用、原型开发

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

## 容量规划

如果你启用了调度器，可以设置记忆容量来控制资源使用情况：

```python
scheduler_config = {
    "memory_capacities": {
        "working_memory_capacity": 20,        # 工作记忆
        "user_memory_capacity": 500,          # 用户记忆
        "long_term_memory_capacity": 2000     # 长时记忆
    }
}
```
