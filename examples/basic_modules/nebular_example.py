import json
import os

from datetime import datetime, timezone

import numpy as np

from dotenv import load_dotenv

from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


load_dotenv()


def show(nebular_data):
    from memos.configs.graph_db import Neo4jGraphDBConfig
    from memos.graph_dbs.neo4j import Neo4jGraphDB

    tree_config = Neo4jGraphDBConfig.from_json_file("../../examples/data/config/neo4j_config.json")
    tree_config.use_multi_db = True
    tree_config.db_name = "nebular-show2"

    neo4j_db = Neo4jGraphDB(tree_config)
    neo4j_db.clear()
    neo4j_db.import_graph(nebular_data)


embedder_config = EmbedderConfigFactory.model_validate(
    {
        "backend": "universal_api",
        "config": {
            "provider": "openai",
            "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
            "model_name_or_path": "text-embedding-3-large",
            "base_url": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
        },
    }
)
embedder = EmbedderFactory.from_config(embedder_config)
embedder_dimension = 3072


def embed_memory_item(memory: str) -> list[float]:
    embedding = embedder.embed([memory])[0]
    embedding_np = np.array(embedding, dtype=np.float32)
    embedding_list = embedding_np.tolist()
    return embedding_list


def example_shared_db(db_name: str = "shared-traval-group"):
    """
    Example: Single(Shared)-DB multi-tenant (logical isolation)
    Multiple users' data in the same Neo4j DB with user_name as a tag.
    """
    # users
    user_list = ["travel_member_alice", "travel_member_bob"]

    for user_name in user_list:
        # Step 1: Build factory config
        config = GraphDBConfigFactory(
            backend="nebular",
            config={
                "uri": json.loads(os.getenv("NEBULAR_HOSTS", "localhost")),
                "user": os.getenv("NEBULAR_USER", "root"),
                "password": os.getenv("NEBULAR_PASSWORD", "xxxxxx"),
                "space": db_name,
                "user_name": user_name,
                "use_multi_db": False,
                "auto_create": True,
                "embedding_dimension": embedder_dimension,
            },
        )

        # Step 2: Instantiate graph store
        graph = GraphStoreFactory.from_config(config)
        print(f"\n[INFO] Working in shared DB: {db_name}, for user: {user_name}")
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

        # Step 4: Add a concept for each user
        concept = TextualMemoryItem(
            memory=f"Itinerary plan for {user_name}",
            metadata=TreeNodeTextualMemoryMetadata(
                memory_type="LongTermMemory",
                key="Multi-UAV Long-Term Coverage",
                hierarchy_level="concept",
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
                embedding=embed_memory_item(f"Itinerary plan for {user_name}"),
            ),
        )

        graph.add_node(
            id=concept.id,
            memory=concept.memory,
            metadata=concept.metadata.model_dump(exclude_none=True),
        )

        # Link concept to topic
        graph.add_edge(source_id=concept.id, target_id=topic.id, type="RELATE_TO")
        print(f"[INFO] Added nodes for {user_name}")

        # Step 5: Query and print ALL for verification
    print("\n=== Export entire DB (for verification, includes ALL users) ===")
    graph = GraphStoreFactory.from_config(config)
    all_graph_data = graph.export_graph()
    print(str(all_graph_data)[:1000])

    # Step 6: Search for alice's data only
    print("\n=== Search for travel_member_alice ===")
    config_alice = GraphDBConfigFactory(
        backend="nebular",
        config={
            "uri": json.loads(os.getenv("NEBULAR_HOSTS", "localhost")),
            "user": os.getenv("NEBULAR_USER", "root"),
            "password": os.getenv("NEBULAR_PASSWORD", "xxxxxx"),
            "space": db_name,
            "user_name": user_list[0],
            "auto_create": True,
            "embedding_dimension": embedder_dimension,
            "use_multi_db": False,
        },
    )
    graph_alice = GraphStoreFactory.from_config(config_alice)
    nodes = graph_alice.search_by_embedding(vector=embed_memory_item("travel itinerary"), top_k=3)
    for node in nodes:
        print(str(graph_alice.get_node(node["id"]))[:1000])


def run_user_session(
    user_name: str,
    db_name: str,
    topic_text: str,
    concept_texts: list[str],
    fact_texts: list[str],
):
    print(f"\n=== {user_name} starts building their memory graph ===")

    # Manually initialize correct GraphDB class
    config = GraphDBConfigFactory(
        backend="nebular",
        config={
            "uri": json.loads(os.getenv("NEBULAR_HOSTS", "localhost")),
            "user": os.getenv("NEBULAR_USER", "root"),
            "password": os.getenv("NEBULAR_PASSWORD", "xxxxxx"),
            "space": db_name,
            "user_name": user_name,
            "use_multi_db": False,
            "auto_create": True,
            "embedding_dimension": embedder_dimension,
        },
    )
    graph = GraphStoreFactory.from_config(config)

    # Start with a clean slate for this user
    graph.clear()

    now = datetime.now(timezone.utc).isoformat()

    # === Step 1: Create a root topic node (e.g., user's research focus) ===
    topic = TextualMemoryItem(
        memory=topic_text,
        metadata=TreeNodeTextualMemoryMetadata(
            memory_type="LongTermMemory",
            key="Research Topic",
            hierarchy_level="topic",
            type="fact",
            memory_time="2024-01-01",
            status="activated",
            visibility="public",
            tags=["research", "rl"],
            updated_at=now,
            embedding=embed_memory_item(topic_text),
        ),
    )
    graph.add_node(topic.id, topic.memory, topic.metadata.model_dump(exclude_none=True))

    # === Step 2: Create two concept nodes linked to the topic ===
    concept_items = []
    for i, text in enumerate(concept_texts):
        concept = TextualMemoryItem(
            memory=text,
            metadata=TreeNodeTextualMemoryMetadata(
                memory_type="LongTermMemory",
                key=f"Concept {i + 1}",
                hierarchy_level="concept",
                type="fact",
                memory_time="2024-01-01",
                status="activated",
                visibility="public",
                updated_at=now,
                embedding=embed_memory_item(text),
                tags=["concept"],
                confidence=90 + i,
            ),
        )
        graph.add_node(concept.id, concept.memory, concept.metadata.model_dump(exclude_none=True))
        graph.add_edge(topic.id, concept.id, type="PARENT")
        concept_items.append(concept)

    # === Step 3: Create supporting facts under each concept ===
    for i, text in enumerate(fact_texts):
        fact = TextualMemoryItem(
            memory=text,
            metadata=TreeNodeTextualMemoryMetadata(
                memory_type="WorkingMemory",
                key=f"Fact {i + 1}",
                hierarchy_level="fact",
                type="fact",
                memory_time="2024-01-01",
                status="activated",
                visibility="public",
                updated_at=now,
                embedding=embed_memory_item(text),
                confidence=85.0,
                tags=["fact"],
            ),
        )
        graph.add_node(fact.id, fact.memory, fact.metadata.model_dump(exclude_none=True))
        graph.add_edge(concept_items[i % len(concept_items)].id, fact.id, type="PARENT")

    # === Step 4: Retrieve memory using semantic search ===
    vector = embed_memory_item("How is memory retrieved?")
    search_result = graph.search_by_embedding(vector, top_k=2)
    for r in search_result:
        node = graph.get_node(r["id"])
        print("🔍 Search result:", node["memory"])

    # === Step 5: Tag-based neighborhood discovery ===
    neighbors = graph.get_neighbors_by_tag(["concept"], exclude_ids=[], top_k=2)
    print("📎 Tag-related nodes:", [neighbor["memory"] for neighbor in neighbors])

    # === Step 6: Retrieve children (facts) of first concept ===
    children = graph.get_children_with_embeddings(concept_items[0].id)
    print("📍 Children of concept:", [child["memory"] for child in children])

    # === Step 7: Export a local subgraph and grouped statistics ===
    subgraph = graph.get_subgraph(topic.id, depth=2)
    print("📌 Subgraph node count:", len(subgraph["neighbors"]))

    stats = graph.get_grouped_counts(["memory_type", "status"])
    print("📊 Grouped counts:", stats)

    # === Step 8: Demonstrate updates and cleanup ===
    graph.update_node(
        concept_items[0].id, {"confidence": 99.0, "created_at": "2025-07-24T20:11:56.375687"}
    )
    graph.remove_oldest_memory("WorkingMemory", keep_latest=1)
    graph.delete_edge(topic.id, concept_items[0].id, type="PARENT")
    graph.delete_node(concept_items[1].id)

    # === Step 9: Export and re-import the entire graph structure ===
    exported = graph.export_graph()
    graph.import_graph(exported)
    print("📦 Graph exported and re-imported, total nodes:", len(exported["nodes"]))

    # ====================================
    # 🔍 Step 10: extra function
    # ====================================
    print(f"\n=== 🔍 Extra Tests for user: {user_name} ===")

    print(" - Memory count:", graph.get_memory_count("LongTermMemory"))
    print(" - Node count:", graph.count_nodes("LongTermMemory"))
    print(" - All LongTermMemory items:", graph.get_all_memory_items("LongTermMemory"))

    if len(exported["edges"]) > 0:
        n1, n2 = exported["edges"][0]["source"], exported["edges"][0]["target"]
        print(" - Edge exists?", graph.edge_exists(n1, n2, exported["edges"][0]["type"]))
        print(" - Edges for node:", graph.get_edges(n1))

    filters = [{"field": "memory_type", "op": "=", "value": "LongTermMemory"}]
    print(" - Metadata query result:", graph.get_by_metadata(filters))
    print(
        " - Optimization candidates:", graph.get_structure_optimization_candidates("LongTermMemory")
    )
    try:
        graph.drop_database()
    except ValueError as e:
        print(" - drop_database raised ValueError as expected:", e)


def example_complex_shared_db(db_name: str = "shared-traval-group-complex"):
    # User 1: Alice explores structured memory for LLMs
    run_user_session(
        user_name="alice",
        db_name=db_name,
        topic_text="Alice studies structured memory and long-term memory optimization in LLMs.",
        concept_texts=[
            "Short-term memory can be simulated using WorkingMemory blocks.",
            "A structured memory graph improves retrieval precision for agents.",
        ],
        fact_texts=[
            "Embedding search is used to find semantically similar memory items.",
            "User memories are stored as node-edge structures that support hierarchical reasoning.",
        ],
    )

    # User 2: Bob focuses on GNN-based reasoning
    run_user_session(
        user_name="bob",
        db_name=db_name,
        topic_text="Bob investigates how graph neural networks can support knowledge reasoning.",
        concept_texts=[
            "GNNs can learn high-order relations among entities.",
            "Attention mechanisms in graphs improve inference precision.",
        ],
        fact_texts=[
            "GAT outperforms GCN in graph classification tasks.",
            "Multi-hop reasoning helps answer complex queries.",
        ],
    )


if __name__ == "__main__":
    print("\n=== Example: Single-DB ===")
    example_shared_db(db_name="shared_traval_group-new")

    print("\n=== Example: Single-DB-Complex ===")
    example_complex_shared_db(db_name="shared-traval-group-complex-new2")
