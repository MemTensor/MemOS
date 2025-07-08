from memos import log
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.llms.factory import LLMFactory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve.reasoner import MemoryReasoner
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal


logger = log.get_logger(__name__)

embedder_config = EmbedderConfigFactory.model_validate(
    {
        "backend": "ollama",
        "config": {
            "model_name_or_path": "nomic-embed-text:latest",
        },
    }
)
embedder = EmbedderFactory.from_config(embedder_config)

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

# Step 1: Prepare a mock ParsedTaskGoal
parsed_goal = ParsedTaskGoal(
    memories=[
        "Multi-UAV Long-Term Coverage",
        "Coverage Metrics",
        "Reward Function Design",
        "Energy Model",
        "CT and FT Definition",
        "Reward Components",
        "Energy Cost Components",
    ],
    keys=["UAV", "coverage", "energy", "reward"],
    tags=[],
    goal_type="explanation",
)

query = "How can multiple UAVs coordinate to maximize coverage while saving energy?"
query_embedding = embedder.embed([query])[0]


# Step 2: Initialize graph store
graph_config = GraphDBConfigFactory(
    backend="neo4j",
    config={
        "uri": "bolt://localhost:7687",
        "user": "neo4j",
        "password": "12345678",
        "db_name": "user06alice",
        "auto_create": True,
    },
)
graph_store = GraphStoreFactory.from_config(graph_config)

ranked_memories = [
    TextualMemoryItem(
        id="a88db9ce-3c77-4e83-8d61-aa9ef95c957e",
        memory="Coverage performance is measured using CT (Coverage Time) and FT (Fairness Time) metrics.",
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=None,
            session_id=None,
            status="activated",
            type="fact",
            memory_time="2024-01-01",
            source="file",
            confidence=91.0,
            entities=["CT", "FT"],
            tags=["coverage", "fairness", "metrics"],
            visibility="public",
            updated_at="2025-06-11T11:51:24.438001",
            memory_type="LongTermMemory",
            key="Coverage Metrics",
            value="CT and FT used for long-term area and fairness evaluation",
            hierarchy_level="concept",
            sources=["paper://multi-uav-coverage/metrics"],
            embedding=[0.01] * 768,
        ),
    ),
    TextualMemoryItem(
        id="c34f5e6b-2d34-4e6f-8c9b-abcdef123456",
        memory="The capital of France is Paris, which is known for the Eiffel Tower.",
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=None,
            session_id=None,
            status="activated",
            type="fact",
            memory_time="2024-01-01",
            source="file",
            confidence=90.0,
            entities=["France", "Paris", "Eiffel Tower"],
            tags=["geography", "city", "landmark"],
            visibility="public",
            updated_at="2025-06-11T11:51:24.438001",
            memory_type="LongTermMemory",
            key="Geography Fact",
            value="Paris is the capital of France",
            hierarchy_level="concept",
            sources=["wikipedia://paris"],
            embedding=[0.03] * 768,
        ),
    ),
    TextualMemoryItem(
        id="d56a7b8c-3e45-4f7a-9dab-fedcba654321",
        memory="Total energy cost is calculated from both mechanical movement and communication transmission.",
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=None,
            session_id=None,
            status="activated",
            type="fact",
            memory_time="2024-01-01",
            source="file",
            confidence=89.0,
            entities=["movement power", "transmission power"],
            tags=["energy", "movement", "transmission"],
            visibility="public",
            updated_at="2025-06-11T11:51:24.438001",
            memory_type="LongTermMemory",
            key="Energy Cost Components",
            value="Includes movement and communication energy",
            hierarchy_level="fact",
            sources=["paper://multi-uav-coverage/energy-detail"],
            embedding=[0.04] * 768,
        ),
    ),
]

# Step 7: Init memory retriever
reasoner = MemoryReasoner(llm=llm)


# Step 8: Print retrieved memory items before ranking
print("\n=== Retrieved Memory Items (Before Rerank) ===")
for idx, item in enumerate(ranked_memories):
    print(f"[Original #{idx + 1}] ID: {item.id}")
    print(f"Memory: {item.memory[:200]}...\n")

# Step 9: Rerank
reasoned_memories = reasoner.reason(
    query=query,
    ranked_memories=ranked_memories,
    parsed_goal=parsed_goal,
)

# Step 10: Print ranked reasoned memory items with original positions
print("\n=== Memory Items After Reason (Sorted) ===")
id_to_original_rank = {item.id: i + 1 for i, item in enumerate(ranked_memories)}

for idx, item in enumerate(reasoned_memories):
    original_rank = id_to_original_rank.get(item.id, "-")
    print(f"[Reasoned #{idx + 1}] ID: {item.id} (Original #{original_rank})")
    print(f"Memory: {item.memory[:200]}...\n")
