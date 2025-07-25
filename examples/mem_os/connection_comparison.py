"""
Comparison: Regular vs Pooled Neo4j connections.

This script demonstrates the difference in connection management
between regular Neo4j backend and the pooled version.
"""

from memos.configs.graph_db import GraphDBConfigFactory
from memos.graph_dbs.connection_pool import connection_pool
from memos.graph_dbs.factory import GraphStoreFactory


def create_graph_instance(backend: str, user_id: str):
    """Create a graph database instance with specified backend."""
    config = GraphDBConfigFactory(
        backend=backend,
        config={
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "12345678",
            "db_name": "test_comparison",
            "user_name": f"user_{user_id}",
            "use_multi_db": False,
            "auto_create": False,  # Skip auto-creation for demo
            "embedding_dimension": 768,
        },
    )
    return GraphStoreFactory.from_config(config)


def demo_regular_connections():
    """Demonstrate regular Neo4j connections (each instance creates own connection)."""
    print("\n=== Regular Neo4j Backend ===")
    instances = []

    for i in range(3):
        print(f"Creating instance {i + 1}...")
        instance = create_graph_instance("neo4j", f"user_{i}")
        instances.append(instance)
        print(f"Instance {i + 1} created with separate connection")

    print(f"Total instances created: {len(instances)}")
    print("Note: Each instance has its own database connection")


def demo_pooled_connections():
    """Demonstrate pooled Neo4j connections (shared connection pool)."""
    print("\n=== Neo4j Pooled Backend ===")
    print(f"Initial pool connections: {connection_pool.get_active_connections()}")

    instances = []

    for i in range(3):
        print(f"Creating instance {i + 1}...")
        instance = create_graph_instance("neo4j-pooled", f"user_{i}")
        instances.append(instance)
        print(f"Pool connections: {connection_pool.get_active_connections()}")

    print(f"Total instances created: {len(instances)}")
    print(f"Shared connections in pool: {connection_pool.get_active_connections()}")
    print("Note: All instances share the same database connection!")


def main():
    """Run the comparison demo."""
    print("=== Neo4j Connection Management Comparison ===")

    # Demo regular connections
    demo_regular_connections()

    # Demo pooled connections
    demo_pooled_connections()

    print("\n=== Summary ===")
    print("• Regular backend: Each instance = 1 connection")
    print("• Pooled backend: Multiple instances = 1 shared connection")
    print("• Pooled version reduces connection overhead for multi-user scenarios")


if __name__ == "__main__":
    main()
