import uuid

from memos import log
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.graph_dbs.item import GraphDBNode
from memos.llms.factory import LLMFactory
from memos.memories.textual.item import TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.relation_reason_detector import (
    RelationAndReasoningDetector,
)


logger = log.get_logger(__name__)

# === Step 1: Initialize embedder ===
embedder_config = EmbedderConfigFactory.model_validate(
    {
        "backend": "ollama",
        "config": {
            "model_name_or_path": "nomic-embed-text:latest",
        },
    }
)
embedder = EmbedderFactory.from_config(embedder_config)

# === Step 2: Initialize Neo4j GraphStore ===
graph_config = GraphDBConfigFactory(
    backend="neo4j",
    config={
        "uri": "bolt://localhost:7687",
        "user": "neo4j",
        "password": "12345678",
        "db_name": "lucy4",
        "auto_create": True,
    },
)
graph_store = GraphStoreFactory.from_config(graph_config)

# === Step 3: Initialize LLM for pairwise relation detection ===
# Step 1: Load LLM config and instantiate
config = LLMConfigFactory.model_validate(
    {
        "backend": "ollama",
        "config": {
            "model_name_or_path": "qwen3:0.6b",
            "temperature": 0.7,
            "max_tokens": 1024,
        },
    }
)
llm = LLMFactory.from_config(config)

# === Step 4: Create a mock GraphDBNode to test relation detection ===

node_a = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="Caroline faced increased workload stress during the project deadline.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Workload stress",
        tags=["stress", "workload"],
        type="fact",
        background="Project",
        confidence=0.95,
        updated_at="2024-06-28T09:00:00Z",
    ),
)

node_b = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="After joining the support group, Caroline reported improved mental health.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Improved mental health",
        tags=["mental health", "support group"],
        type="fact",
        background="Personal follow-up",
        confidence=0.95,
        updated_at="2024-07-10T12:00:00Z",
    ),
)

node_c = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="Peer support groups are effective in reducing stress for LGBTQ individuals.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Support group benefits",
        tags=["LGBTQ", "support group", "stress"],
        type="fact",
        background="General research",
        confidence=0.95,
        updated_at="2024-06-29T14:00:00Z",
    ),
)

# === D: Work pressure ➜ stress ===
node_d = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="Excessive work pressure increases stress levels among employees.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Work pressure impact",
        tags=["stress", "work pressure"],
        type="fact",
        background="Workplace study",
        confidence=0.9,
        updated_at="2024-06-15T08:00:00Z",
    ),
)

# === E: Stress ➜ poor sleep ===
node_e = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="High stress levels often result in poor sleep quality.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Stress and sleep",
        tags=["stress", "sleep"],
        type="fact",
        background="Health study",
        confidence=0.9,
        updated_at="2024-06-18T10:00:00Z",
    ),
)

# === F: Poor sleep ➜ low performance ===
node_f = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="Employees with poor sleep show reduced work performance.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Sleep and performance",
        tags=["sleep", "performance"],
        type="fact",
        background="HR report",
        confidence=0.9,
        updated_at="2024-06-20T12:00:00Z",
    ),
)

node = GraphDBNode(
    id="a88db9ce-3c77-4e83-8d61-aa9ef95c957e",
    memory="Caroline joined an LGBTQ support group to cope with work-related stress.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=embedder.embed(
            ["Caroline joined an LGBTQ support group to cope with work-related stress."]
        )[0],
        key="Caroline LGBTQ stress",
        tags=["LGBTQ", "support group", "stress"],
        type="fact",
        background="Personal",
        confidence=0.95,
        updated_at="2024-07-01T10:00:00Z",
    ),
)


for n in [node, node_a, node_b, node_c, node_d, node_e, node_f]:
    graph_store.add_node(n.id, n.memory, n.metadata.dict())


# === Step 5: Initialize RelationDetector and run detection ===
relation_detector = RelationAndReasoningDetector(
    graph_store=graph_store, llm=llm, embedder=embedder
)

results = relation_detector.process_node(
    node=node,
    exclude_ids=[node.id],  # Exclude self when searching for neighbors
    top_k=5,
)

# === Step 6: Print detected relations ===
print("\n=== Detected Global Relations ===")


# === Step 6: Pretty-print detected results ===
print("\n=== Detected Pairwise Relations ===")
for rel in results["relations"]:
    print(f"  Source ID: {rel['source_id']}")
    print(f"  Target ID: {rel['target_id']}")
    print(f"  Relation Type: {rel['relation_type']}")
    print("------")

print("\n=== Inferred Nodes ===")
for node in results["inferred_nodes"]:
    print(f"  New Fact: {node.memory}")
    print(f"  Sources: {node.metadata.sources}")
    print("------")

print("\n=== Sequence Links (FOLLOWS) ===")
for link in results["sequence_links"]:
    print(f"  From: {link['from_id']} -> To: {link['to_id']}")
    print("------")

print("\n=== Aggregate Concepts ===")
for agg in results["aggregate_nodes"]:
    print(f"  Concept Key: {agg.metadata.key}")
    print(f"  Concept Memory: {agg.memory}")
    print(f"  Sources: {agg.metadata.sources}")
    print("------")
