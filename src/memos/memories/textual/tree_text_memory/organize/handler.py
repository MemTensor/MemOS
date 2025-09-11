import json
import re

from datetime import datetime

from dateutil import parser

from memos.embedders.base import BaseEmbedder
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.templates.tree_reorganize_prompts import (
    MEMORY_RELATION_DETECTOR_PROMPT,
    MEMORY_RELATION_RESOLVER_PROMPT,
)


logger = get_logger(__name__)


class NodeHandler:
    EMBEDDING_THRESHOLD: float = 0.8  # Threshold for embedding similarity to consider conflict

    def __init__(self, graph_store: Neo4jGraphDB, llm: BaseLLM, embedder: BaseEmbedder):
        self.graph_store = graph_store
        self.llm = llm
        self.embedder = embedder

    def detect(self, memory, top_k: int = 5, scope=None):
        # 1. Search for similar memories based on embedding
        embedding = memory.metadata.embedding
        embedding_candidates_info = self.graph_store.search_by_embedding(
            embedding, top_k=top_k, scope=scope, threshold=self.EMBEDDING_THRESHOLD
        )
        # 2. Filter based on similarity threshold
        embedding_candidates_ids = [
            info["id"] for info in embedding_candidates_info if info["id"] != memory.id
        ]
        # 3. Judge conflicts using LLM
        embedding_candidates = self.graph_store.get_nodes(embedding_candidates_ids)
        detected_relationships = []
        for embedding_candidate in embedding_candidates:
            embedding_candidate = TextualMemoryItem.from_dict(embedding_candidate)
            prompt = [
                {
                    "role": "user",
                    "content": MEMORY_RELATION_DETECTOR_PROMPT.format(
                        statement_1=memory.memory, statement_2=embedding_candidate.memory
                    ),
                }
            ]
            result = self.llm.generate(prompt).strip()
            if result == "contradictory":
                logger.warning(
                    f'detected "{memory.memory}" <==CONFLICT==> "{embedding_candidate.memory}"'
                )
                detected_relationships.append([memory, embedding_candidate, "contradictory"])
            elif result == "redundant":
                logger.warning(
                    f'detected "{memory.memory}" <==REDUNDANT==> "{embedding_candidate.memory}"'
                )
                detected_relationships.append([memory, embedding_candidate, "redundant"])
            elif result == "independent":
                pass
            else:
                pass
        return detected_relationships

    def resolve(self, memory_a: TextualMemoryItem, memory_b: TextualMemoryItem, relation) -> None:
        """
        Resolve detected conflicts between two memory items using LLM fusion.
        Args:
            memory_a: The first conflicting memory item.
            memory_b: The second conflicting memory item.
            relation: relation
        Returns:
            A fused TextualMemoryItem representing the resolved memory.
        """

        # ———————————— 1. LLM generate fused memory ————————————
        metadata_for_resolve = ["key", "background", "confidence", "updated_at"]
        metadata_1 = memory_a.metadata.model_dump_json(include=metadata_for_resolve)
        metadata_2 = memory_b.metadata.model_dump_json(include=metadata_for_resolve)
        prompt = [
            {
                "role": "user",
                "content": MEMORY_RELATION_RESOLVER_PROMPT.format(
                    relation=relation,
                    statement_1=memory_a.memory,
                    metadata_1=metadata_1,
                    statement_2=memory_b.memory,
                    metadata_2=metadata_2,
                ),
            },
        ]
        response = self.llm.generate(prompt).strip()

        # ———————————— 2. Parse the response ————————————
        try:
            answer = re.search(r"<answer>(.*?)</answer>", response, re.DOTALL)
            answer = answer.group(1).strip()
            # —————— 2.1 Can't resolve conflict, hard update by comparing timestamp ————
            if len(answer) <= 10 and "no" in answer.lower():
                logger.warning(
                    f"{relation} between {memory_a.id} and {memory_b.id} could not be resolved. "
                )
                self._hard_update(memory_a, memory_b)
            # —————— 2.2 Conflict resolved, update metadata and memory ————
            else:
                fixed_metadata = self._merge_metadata(answer, memory_a.metadata, memory_b.metadata)
                merged_memory = TextualMemoryItem(memory=answer, metadata=fixed_metadata)
                logger.info(f"Resolved result: {merged_memory}")
                self._resolve_in_graph(memory_a, memory_b, merged_memory)
        except json.decoder.JSONDecodeError:
            logger.error(f"Failed to parse LLM response: {response}")

    def _hard_update(self, memory_a: TextualMemoryItem, memory_b: TextualMemoryItem):
        """
        Hard update: compare updated_at, keep the newer one, overwrite the older one's metadata.
        """
        time_a = parser.isoparse(memory_a.metadata.updated_at)
        time_b = parser.isoparse(memory_b.metadata.updated_at)

        newer_mem = memory_a if time_a >= time_b else memory_b
        older_mem = memory_b if time_a >= time_b else memory_a

        self.graph_store.delete_node(older_mem.id)
        logger.warning(
            f"Delete older memory {older_mem.id}: <{older_mem.memory}> due to conflict with {newer_mem.id}: <{newer_mem.memory}>"
        )

    def _resolve_in_graph(
        self,
        conflict_a: TextualMemoryItem,
        conflict_b: TextualMemoryItem,
        merged: TextualMemoryItem,
    ):
        edges_a = self.graph_store.get_edges(conflict_a.id, type="ANY", direction="ANY")
        edges_b = self.graph_store.get_edges(conflict_b.id, type="ANY", direction="ANY")
        all_edges = edges_a + edges_b

        self.graph_store.add_node(
            merged.id, merged.memory, merged.metadata.model_dump(exclude_none=True)
        )

        for edge in all_edges:
            new_from = merged.id if edge["from"] in (conflict_a.id, conflict_b.id) else edge["from"]
            new_to = merged.id if edge["to"] in (conflict_a.id, conflict_b.id) else edge["to"]
            if new_from == new_to:
                continue
            # Check if the edge already exists before adding
            if not self.graph_store.edge_exists(new_from, new_to, edge["type"], direction="ANY"):
                self.graph_store.add_edge(new_from, new_to, edge["type"])

        self.graph_store.update_node(conflict_a.id, {"status": "archived"})
        self.graph_store.update_node(conflict_b.id, {"status": "archived"})
        self.graph_store.add_edge(conflict_a.id, merged.id, type="MERGED_TO")
        self.graph_store.add_edge(conflict_b.id, merged.id, type="MERGED_TO")
        logger.debug(
            f"Archive {conflict_a.id} and {conflict_b.id}, and inherit their edges to {merged.id}."
        )

    def _merge_metadata(
        self,
        memory: str,
        metadata_a: TreeNodeTextualMemoryMetadata,
        metadata_b: TreeNodeTextualMemoryMetadata,
    ) -> TreeNodeTextualMemoryMetadata:
        metadata_1 = metadata_a.model_dump()
        metadata_2 = metadata_b.model_dump()
        merged_metadata = {
            "sources": (metadata_1["sources"] or []) + (metadata_2["sources"] or []),
            "embedding": self.embedder.embed([memory])[0],
            "update_at": datetime.now().isoformat(),
            "created_at": datetime.now().isoformat(),
        }
        for key in metadata_1:
            if key in merged_metadata:
                continue
            merged_metadata[key] = (
                metadata_1[key] if metadata_1[key] is not None else metadata_2[key]
            )
        return TreeNodeTextualMemoryMetadata.model_validate(merged_metadata)
