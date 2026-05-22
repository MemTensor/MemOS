---
title: "PolarDB Graph Database"
desc: "Configuration and usage of PolarDB graph database in the MemOS framework. MemOS supports using **PolarDB** (based on Apache AGE extension) as a graph database backend for storing and retrieving knowledge graph-style memory data. PolarDB combines the powerful capabilities of PostgreSQL with the flexibility of graph databases, making it particularly suitable for scenarios requiring both relational and graph data queries."
---




## Features

::list{icon="ph:check-circle-duotone"}
- Complete graph database operations: node CRUD, edge management
- Vector embedding search: semantic retrieval with IVFFlat index support
- Connection pool management: automatic database connection management with high concurrency support
- Multi-tenant isolation: supports both physical and logical isolation modes
- JSONB property storage: flexible metadata storage
- Batch operations: supports batch insertion of nodes and edges
- Automatic timestamps: automatically maintains `created_at` and `updated_at`
- SQL injection protection: built-in parameterized queries and string escaping
::

## Directory Structure

```
MemOS/
└── src/
    └── memos/
        ├── configs/
        │   └── graph_db.py              # PolarDBGraphDBConfig configuration class
        └── graph_dbs/
            ├── base.py                  # BaseGraphDB abstract base class
            ├── factory.py               # GraphDBFactory factory class
            └── polardb.py               # PolarDBGraphDB implementation
```

## Quick Start

### 1. Install Dependencies

```bash
# Install psycopg2 driver (choose one)
pip install psycopg2-binary  # Recommended: pre-compiled version
# or
pip install psycopg2          # Requires PostgreSQL development libraries

# Install MemOS
pip install MemoryOS -U
```

### 2. Configure PolarDB

#### Method 1: Using Configuration File (Recommended)

```json
{
  "graph_db_store": {
    "backend": "polardb",
    "config": {
      "host": "localhost",
      "port": 5432,
      "user": "postgres",
      "password": "your_password",
      "db_name": "memos_db",
      "user_name": "alice",
      "use_multi_db": true,
      "auto_create": false,
      "embedding_dimension": 1024,
      "maxconn": 100
    }
  }
}
```

#### Method 2: Code Initialization

```python
from memos.configs.graph_db import PolarDBGraphDBConfig
from memos.graph_dbs.polardb import PolarDBGraphDB

# Create configuration
config = PolarDBGraphDBConfig(
    host="localhost",
    port=5432,
    user="postgres",
    password="your_password",
    db_name="memos_db",
    user_name="alice",
    use_multi_db=True,
    embedding_dimension=1024,
    maxconn=100
)

# Initialize database
graph_db = PolarDBGraphDB(config)
```

### 3. Basic Operation Examples

```python
# ========================================
# Step 1: Add Node
# ========================================
node_id = graph_db.add_node(
    label="Memory",
    properties={
        "content": "Python is a high-level programming language",
        "memory_type": "Knowledge",
        "tags": ["programming", "python"]
    },
    embedding=[0.1, 0.2, 0.3, ...],  # 1024-dimensional vector
    user_name="alice"
)
print(f"✓ Node created: {node_id}")

# ========================================
# Step 2: Update Node
# ========================================
graph_db.update_node(
    id=node_id,
    fields={
        "content": "Python is an interpreted, object-oriented high-level programming language",
        "updated": True
    },
    user_name="alice"
)
print("✓ Node updated")

# ========================================
# Step 3: Create Relationship
# ========================================
# First create a second node
node_id_2 = graph_db.add_node(
    label="Memory",
    properties={
        "content": "Django is a web framework for Python",
        "memory_type": "Knowledge"
    },
    embedding=[0.15, 0.25, 0.35, ...],
    user_name="alice"
)

# Create edge
edge_id = graph_db.add_edge(
    source_id=node_id,
    target_id=node_id_2,
    edge_type="RELATED_TO",
    properties={
        "relationship": "framework and language",
        "confidence": 0.95
    },
    user_name="alice"
)
print(f"✓ Relationship created: {edge_id}")

# ========================================
# Step 4: Vector Search
# ========================================
query_embedding = [0.12, 0.22, 0.32, ...]  # Query vector

results = graph_db.search_by_embedding(
    embedding=query_embedding,
    top_k=5,
    memory_type="Knowledge",
    user_name="alice"
)

print(f"\n🔍 Found {len(results)} similar nodes:")
for node in results:
    print(f"  - {node.get('content')} (similarity: {node.get('score', 'N/A')})")

# ========================================
# Step 5: Delete Node
# ========================================
graph_db.delete_node(id=node_id, user_name="alice")
print(f"✓ Node {node_id} deleted")
```

## Configuration Details

### PolarDBGraphDBConfig Parameters

| Parameter | Type | Default | Required | Description |
|------|------|--------|------|------|
| `host` | str | - | ✓ | Database host address |
| `port` | int | 5432 | ✗ | Database port |
| `user` | str | - | ✓ | Database username |
| `password` | str | - | ✓ | Database password |
| `db_name` | str | - | ✓ | Target database name |
| `user_name` | str | None | ✗ | Tenant identifier (for logical isolation) |
| `use_multi_db` | bool | True | ✗ | Whether to use multi-database physical isolation |
| `auto_create` | bool | False | ✗ | Whether to automatically create database |
| `embedding_dimension` | int | 1024 | ✗ | Vector embedding dimension |
| `maxconn` | int | 100 | ✗ | Maximum connections in connection pool |

### Multi-Tenant Mode Comparison

| Feature | Physical Isolation<br/>(`use_multi_db=True`) | Logical Isolation<br/>(`use_multi_db=False`) |
|------|-----------------------------------|-------------------------------------|
| **Isolation Level** | Database level | Application layer tag filtering |
| **Configuration Requirements** | `db_name` typically equals `user_name` | Must provide `user_name` |
| **Performance** | Better (independent resources) | Good (shared resources) |
| **Cost** | High (independent DB per tenant) | Low (shared database) |
| **Use Cases** | Enterprise customers, high security requirements | SaaS multi-tenant, development testing |
| **Data Migration** | Convenient (full database export) | Requires filtering by tags |

### Configuration Examples

#### Example 1: Physical Isolation (Recommended for Enterprise)

```json
{
  "graph_db_store": {
    "backend": "polardb",
    "config": {
      "host": "prod-polardb.example.com",
      "port": 5432,
      "user": "admin",
      "password": "secure_password",
      "db_name": "customer_001",
      "user_name": null,
      "use_multi_db": true,
      "auto_create": false,
      "embedding_dimension": 1536,
      "maxconn": 200
    }
  }
}
```

#### Example 2: Logical Isolation (Recommended for SaaS)

```json
{
  "graph_db_store": {
    "backend": "polardb",
    "config": {
      "host": "shared-polardb.example.com",
      "port": 5432,
      "user": "app_user",
      "password": "app_password",
      "db_name": "shared_memos",
      "user_name": "tenant_alice",
      "use_multi_db": false,
      "auto_create": false,
      "embedding_dimension": 768,
      "maxconn": 50
    }
  }
}
```

## Advanced Features

### 1. Batch Insert Nodes

```python
# Batch add nodes (high performance)
nodes_data = [
    {
        "label": "Memory",
        "properties": {"content": f"Node {i}", "memory_type": "Test"},
        "embedding": [0.1 * i] * 1024,
    }
    for i in range(100)
]

node_ids = graph_db.add_nodes_batch(
    nodes=nodes_data,
    user_name="alice"
)
print(f"✓ Batch created {len(node_ids)} nodes")
```

### 2. Complex Query Examples

```python
# Find memories of specific type and sort by time
def get_recent_memories(graph_db, memory_type, limit=10):
    """Get recent memory nodes"""
    query = f"""
        SELECT * FROM "{graph_db.db_name}_graph"."Memory"
        WHERE properties->>'memory_type' = %s
          AND properties->>'user_name' = %s
        ORDER BY updated_at DESC
        LIMIT %s
    """

    conn = graph_db._get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(query, [memory_type, "alice", limit])
            results = cursor.fetchall()
            return results
    finally:
        graph_db._return_connection(conn)

# Usage example
recent = get_recent_memories(graph_db, "WorkingMemory", limit=5)
print(f"Recent 5 working memories: {len(recent)} items")
```

### 3. Vector Index Optimization

```python
# Create or update vector index
graph_db.create_index(
    label="Memory",
    vector_property="embedding",
    dimensions=1024,
    index_name="memory_vector_index"
)
print("✓ Vector index optimized")
```

### 4. Connection Pool Monitoring

```python
# View connection pool status (for debugging only)
import logging
logging.basicConfig(level=logging.DEBUG)

# Detailed logs will be output when acquiring connection
conn = graph_db._get_connection()
# [DEBUG] [_get_connection] Successfully acquired connection from pool
graph_db._return_connection(conn)
# [DEBUG] [_return_connection] Successfully returned connection to pool
```

## BaseGraphDB Interface

PolarDB implements all methods of the `BaseGraphDB` abstract class, ensuring interoperability with other graph database backends.

### Core Methods

| Method | Description | Parameters |
|------|------|------|
| `add_node()` | Add a single node | label, properties, embedding, user_name |
| `add_nodes_batch()` | Batch add nodes | nodes, user_name |
| `update_node()` | Update node properties | id, fields, user_name |
| `delete_node()` | Delete node | id, user_name |
| `delete_node_by_params()` | Delete nodes by conditions | params, user_name |
| `add_edge()` | Create relationship | source_id, target_id, edge_type, properties, user_name |
| `update_edge()` | Update relationship properties | edge_id, properties, user_name |
| `delete_edge()` | Delete relationship | edge_id, user_name |
| `search_by_embedding()` | Vector similarity search | embedding, top_k, memory_type, user_name |
| `get_node()` | Get a single node | id, user_name |
| `get_memory_count()` | Count nodes | memory_type, user_name |
| `remove_oldest_memory()` | Clean old memories | memory_type, keep_latest, user_name |

### Complete Method Signature Examples

```python
from typing import Any

# Add node
def add_node(
    self,
    label: str = "Memory",
    properties: dict[str, Any] | None = None,
    embedding: list[float] | None = None,
    user_name: str | None = None
) -> str:
    """Add a new node to the graph database"""
    pass

# Vector search
def search_by_embedding(
    self,
    embedding: list[float],
    top_k: int = 10,
    memory_type: str | None = None,
    user_name: str | None = None,
    filters: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Perform similarity search based on vector embedding"""
    pass

# Batch operations
def add_nodes_batch(
    self,
    nodes: list[dict[str, Any]],
    user_name: str | None = None
) -> list[str]:
    """Batch add multiple nodes"""
    pass
```

## Extension Development Guide

If you need to implement custom functionality based on PolarDB, you can inherit the `PolarDBGraphDB` class:

```python
from memos.graph_dbs.polardb import PolarDBGraphDB
from memos.configs.graph_db import PolarDBGraphDBConfig

class CustomPolarDBGraphDB(PolarDBGraphDB):
    """Custom PolarDB graph database implementation"""

    def __init__(self, config: PolarDBGraphDBConfig):
        super().__init__(config)
        # Custom initialization logic
        self.custom_index_created = False

    def create_custom_index(self):
        """Create custom index"""
        conn = self._get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_custom_field
                    ON "{self.db_name}_graph"."Memory"
                    ((properties->>'custom_field'));
                """)
                conn.commit()
                self.custom_index_created = True
                print("✓ Custom index created")
        except Exception as e:
            print(f"❌ Failed to create index: {e}")
            conn.rollback()
        finally:
            self._return_connection(conn)

    def search_by_custom_field(self, field_value: str):
        """Search based on custom field"""
        query = f"""
            SELECT * FROM "{self.db_name}_graph"."Memory"
            WHERE properties->>'custom_field' = %s
        """

        conn = self._get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, [field_value])
                results = cursor.fetchall()
                return results
        finally:
            self._return_connection(conn)

# Use custom implementation
config = PolarDBGraphDBConfig(
    host="localhost",
    port=5432,
    user="postgres",
    password="password",
    db_name="custom_db"
)

custom_db = CustomPolarDBGraphDB(config)
custom_db.create_custom_index()
results = custom_db.search_by_custom_field("special_value")
```

## Reference Resources

- [Apache AGE Official Documentation](https://age.apache.org/)
- [PostgreSQL Connection Pool Documentation](https://www.psycopg.org/docs/pool.html)
- [PolarDB Official Documentation](https://www.alibabacloud.com/product/polardb)
- [MemOS GitHub Repository](https://github.com/MemOS-AI/MemOS)

## Next Steps

- Learn about using [Neo4j Graph Database](./neo4j_graph_db.md)
- Check out [General Textual Memory](./general_textual_memory.md) configuration
- Explore advanced features of [Tree Textual Memory](./tree_textual_memory.md)
