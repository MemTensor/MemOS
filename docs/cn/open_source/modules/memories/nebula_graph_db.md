---
title: 基于 NebulaGraph 的明文记忆后端
desc: "该模块为记忆增强系统（如 RAG、认知代理或个人助手）提供基于 NebulaGraph 的记忆图谱存储与查询能力。继承自 `BaseGraphDB`，支持多用户隔离、结构化搜索、外挂向量索引等能力，适用于大规模图谱构建与推理。"
---

## 为什么选择 NebulaGraph?

* 适合大规模分布式部署
* 支持点、边的标签与属性灵活定义
* 支持向量索引（Nebula 5 起）


## 推荐配置模板

适用于生产场景、兼容多租户逻辑隔离：

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

* `space`：Nebula 图空间名称，相当于数据库
* `user_name`：用于多用户逻辑隔离（自动注入过滤条件）
* `embedding_dimension`：根据你的嵌入模型调整（如 text-embedding-3-large 为 3072）
* `auto_create`: 是否自动创建图空间及 Schema（推荐测试环境使用）


## 多租户使用模式

NebulaGraph 后端支持两种多租户架构：

### 单库多用户（Shared DB + `user_name`）

适用于多个用户/Agent 共用图空间，每位用户使用逻辑隔离：

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

### 多库（Multi DB，每用户一空间）

适用于资源隔离更强场景，每个用户独占一个图空间（space）：

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

## 快速使用示例

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
