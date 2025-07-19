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
        backend="neo4j",
        config={
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "12345678",
            "db_name": db_name,
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

    # Step 4: Define and write concept nodes
    concepts = [
        TextualMemoryItem(
            memory="The reward function combines multiple objectives: coverage maximization, energy consumption minimization, and overlap penalty.",
            metadata=TreeNodeTextualMemoryMetadata(
                memory_type="LongTermMemory",
                key="Reward Function Design",
                hierarchy_level="concept",
                type="fact",
                memory_time="2024-01-01",
                source="file",
                sources=["paper://multi-uav-coverage/reward"],
                status="activated",
                confidence=92.0,
                tags=["reward", "DRL", "multi-objective"],
                entities=["reward function"],
                visibility="public",
                updated_at=datetime.now().isoformat(),
                embedding=embed_memory_item(
                    "The reward function combines "
                    "multiple objectives: coverage "
                    "maximization, energy consumption "
                    "minimization, and overlap penalty."
                ),
            ),
        ),
        TextualMemoryItem(
            memory="The energy model considers transmission power and mechanical movement power consumption.",
            metadata=TreeNodeTextualMemoryMetadata(
                memory_type="LongTermMemory",
                key="Energy Model",
                hierarchy_level="concept",
                type="fact",
                memory_time="2024-01-01",
                source="file",
                sources=["paper://multi-uav-coverage/energy"],
                status="activated",
                confidence=90.0,
                tags=["energy", "power model"],
                entities=["energy", "power"],
                visibility="public",
                updated_at=datetime.now().isoformat(),
                embedding=embed_memory_item(
                    "The energy model considers "
                    "transmission power and mechanical movement power consumption."
                ),
            ),
        ),
        TextualMemoryItem(
            memory="Coverage performance is measured using CT (Coverage Time) and FT (Fairness Time) metrics.",
            metadata=TreeNodeTextualMemoryMetadata(
                memory_type="LongTermMemory",
                key="Coverage Metrics",
                hierarchy_level="concept",
                type="fact",
                memory_time="2024-01-01",
                source="file",
                sources=["paper://multi-uav-coverage/metrics"],
                status="activated",
                confidence=91.0,
                tags=["coverage", "fairness", "metrics"],
                entities=["CT", "FT"],
                visibility="public",
                updated_at=datetime.now().isoformat(),
                embedding=embed_memory_item(
                    "The energy model considers "
                    "transmission power and mechanical movement power consumption."
                ),
            ),
        ),
    ]

    # Step 5: Write and link concepts to topic
    for concept in concepts:
        graph.add_node(
            id=concept.id,
            memory=concept.memory,
            metadata=concept.metadata.model_dump(exclude_none=True),
        )
        graph.add_edge(source_id=concept.id, target_id=topic.id, type="RELATED")
        print(f"Creating edge: ({concept.id}) -[:{type}]-> ({topic.id})")

    # Define concept → fact
    fact_pairs = [
        {
            "concept_key": "Reward Function Design",
            "fact": TextualMemoryItem(
                memory="The reward includes three parts: (1) coverage gain, (2) energy penalty, and (3) penalty for overlapping areas with other UAVs.",
                metadata=TreeNodeTextualMemoryMetadata(
                    memory_type="WorkingMemory",
                    key="Reward Components",
                    hierarchy_level="fact",
                    type="fact",
                    memory_time="2024-01-01",
                    source="file",
                    sources=["paper://multi-uav-coverage/reward-details"],
                    status="activated",
                    confidence=90.0,
                    tags=["reward", "overlap", "multi-agent"],
                    entities=["coverage", "energy", "overlap"],
                    visibility="public",
                    updated_at=datetime.now().isoformat(),
                    embedding=embed_memory_item(
                        "The reward includes three parts: (1) coverage gain, (2) energy penalty, and (3) penalty for overlapping areas with other UAVs."
                    ),
                ),
            ),
        },
        {
            "concept_key": "Energy Model",
            "fact": TextualMemoryItem(
                memory="Total energy cost is calculated from both mechanical movement and communication transmission.",
                metadata=TreeNodeTextualMemoryMetadata(
                    memory_type="LongTermMemory",
                    key="Energy Cost Components",
                    hierarchy_level="fact",
                    type="fact",
                    memory_time="2024-01-01",
                    source="file",
                    sources=["paper://multi-uav-coverage/energy-detail"],
                    status="activated",
                    confidence=89.0,
                    tags=["energy", "movement", "transmission"],
                    entities=["movement power", "transmission power"],
                    visibility="public",
                    updated_at=datetime.now().isoformat(),
                    embedding=embed_memory_item(
                        "Total energy cost is calculated from both mechanical movement and communication transmission."
                    ),
                ),
            ),
        },
        {
            "concept_key": "Coverage Metrics",
            "fact": TextualMemoryItem(
                memory="CT measures how long the area is covered; FT reflects the fairness of agent coverage distribution.",
                metadata=TreeNodeTextualMemoryMetadata(
                    memory_type="LongTermMemory",
                    key="CT and FT Definition",
                    hierarchy_level="fact",
                    type="fact",
                    memory_time="2024-01-01",
                    source="file",
                    sources=["paper://multi-uav-coverage/metric-definitions"],
                    status="activated",
                    confidence=91.0,
                    tags=["CT", "FT", "fairness"],
                    entities=["coverage time", "fairness"],
                    visibility="public",
                    updated_at=datetime.now().isoformat(),
                    embedding=embed_memory_item(
                        "CT measures how long the area is covered; FT reflects the fairness of agent coverage distribution."
                    ),
                ),
            ),
        },
    ]

    # Write facts and link to corresponding concept by key
    concept_map = {concept.metadata.key: concept.id for concept in concepts}

    for pair in fact_pairs:
        fact_item = pair["fact"]
        concept_key = pair["concept_key"]
        concept_id = concept_map[concept_key]

        graph.add_node(
            fact_item.id,
            fact_item.memory,
            metadata=fact_item.metadata.model_dump(exclude_none=True),
        )
        graph.add_edge(source_id=fact_item.id, target_id=concept_id, type="BELONGS_TO")

    all_graph_data = graph.export_graph()
    print(all_graph_data)

    nodes = graph.search_by_embedding(vector=embed_memory_item("what does FT reflect?"), top_k=1)

    for node_i in nodes:
        print(graph.get_node(node_i["id"]))


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
            backend="neo4j",
            config={
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "12345678",
                "db_name": db_name,
                "user_name": user_name,
                "use_multi_db": False,
                "auto_create": True,
                "embedding_dimension": 768,
            },
        )
        # Step 2: Instantiate graph store
        graph = GraphStoreFactory.from_config(config)
        print(f"\n[INFO] Working in shared DB: {db_name}, for user: {user_name}")
        graph.clear()

        # Step 3: Create topic node
        topic = TextualMemoryItem(
            memory=f"Travel notes for {user_name}",
            metadata=TreeNodeTextualMemoryMetadata(
                memory_type="LongTermMemory",
                hierarchy_level="topic",
                status="activated",
                visibility="public",
                embedding=embed_memory_item(f"Travel notes for {user_name}"),
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
                hierarchy_level="concept",
                status="activated",
                visibility="public",
                embedding=embed_memory_item(f"Itinerary plan for {user_name}"),
            ),
        )

        graph.add_node(
            id=concept.id,
            memory=concept.memory,
            metadata=concept.metadata.model_dump(exclude_none=True),
        )

        # Link concept to topic
        graph.add_edge(source_id=concept.id, target_id=topic.id, type="INCLUDE")

        print(f"[INFO] Added nodes for {user_name}")

    # Step 5: Query and print ALL for verification
    print("\n=== Export entire DB (for verification, includes ALL users) ===")
    graph = GraphStoreFactory.from_config(config)
    all_graph_data = graph.export_graph()
    print(all_graph_data)

    # Step 6: Search for alice's data only
    print("\n=== Search for travel_member_alice ===")
    config_alice = GraphDBConfigFactory(
        backend="neo4j",
        config={
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "12345678",
            "db_name": db_name,
            "user_name": user_list[0],
            "embedding_dimension": 768,
        },
    )
    graph_alice = GraphStoreFactory.from_config(config_alice)
    nodes = graph_alice.search_by_embedding(vector=embed_memory_item("travel itinerary"), top_k=1)
    for node in nodes:
        print(graph_alice.get_node(node["id"]))


def run_user_session(
    user_name: str,
    db_name: str,
    topic_text: str,
    concept_texts: list[str],
    fact_texts: list[str],
    community: bool = False,
):
    print(f"\n=== {user_name} starts building their memory graph ===")

    # Manually initialize correct GraphDB class
    if community:
        config = GraphDBConfigFactory(
            backend="neo4j-community",
            config={
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "12345678",
                "db_name": db_name,
                "user_name": user_name,
                "use_multi_db": False,
                "auto_create": False,  # Neo4j Community does not allow auto DB creation
                "embedding_dimension": 768,
                "vec_config": {
                    # Pass nested config to initialize external vector DB
                    # If you use qdrant, please use Server instead of local mode.
                    "backend": "qdrant",
                    "config": {
                        "collection_name": "neo4j_vec_db",
                        "vector_dimension": 768,
                        "distance_metric": "cosine",
                        "host": "localhost",
                        "port": 6333,
                    },
                },
            },
        )
    else:
        config = GraphDBConfigFactory(
            backend="neo4j",
            config={
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "12345678",
                "db_name": db_name,
                "user_name": user_name,
                "use_multi_db": False,
                "auto_create": True,
                "embedding_dimension": 768,
            },
        )
    graph = GraphStoreFactory.from_config(config)

    # Start with a clean slate for this user
    graph.clear()

    now = datetime.utcnow().isoformat()

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
    graph.update_node(concept_items[0].id, {"confidence": 99.0})
    graph.remove_oldest_memory("WorkingMemory", keep_latest=1)
    graph.delete_edge(topic.id, concept_items[0].id, type="PARENT")
    graph.delete_node(concept_items[1].id)

    # === Step 9: Export and re-import the entire graph structure ===
    exported = graph.export_graph()
    graph.import_graph(exported)
    print("📦 Graph exported and re-imported, total nodes:", len(exported["nodes"]))


def example_complex_shared_db(db_name: str = "shared-traval-group-complex", community=False):
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
        community=community,
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
        community=community,
    )


if __name__ == "__main__":
    print("\n=== Example: Multi-DB ===")
    example_multi_db(db_name="paper")

    print("\n=== Example: Single-DB ===")
    example_shared_db(db_name="shared-traval-group")

    print("\n=== Example: Single-DB-Complex ===")
    example_complex_shared_db(db_name="shared-traval-group-complex-new")

    print("\n=== Example: Single-Community-DB-Complex ===")
    example_complex_shared_db(db_name="paper", community=True)
