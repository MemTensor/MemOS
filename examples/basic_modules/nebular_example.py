from datetime import datetime

from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


embedder_config = EmbedderConfigFactory.model_validate(
    {"backend": "ollama", "config": {"model_name_or_path": "nomic-embed-text:latest"}}
)
embedder = EmbedderFactory.from_config(embedder_config)


def embed_memory_item(memory: str) -> list[float]:
    return embedder.embed([memory])[0]


def example_multi_db(db_name: str = "paper"):
    # Step 1: Build factory config
    config = GraphDBConfigFactory(
        backend="nebular",
        config={
            "hosts": [
                "xxx.xx.xx.xxx:xxxx",
                "xxx.xx.xx.xxx:xxxx",
                "xxx.xx.xx.xxx:xxxx",
            ],
            "user_name": "root",
            "password": "Nebular_password",
            "space": db_name,
            "auto_create": True,
            "embedding_dimension": 768,
            "use_multi_db": True,
        },
    )

    # Step 2: Instantiate the graph store
    graph = GraphStoreFactory.from_config(config)
    graph.clear()

    # Step 3: Create topic node
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


if __name__ == "__main__":
    print("\n=== Example: Multi-DB ===")
    example_multi_db(db_name="paper")
