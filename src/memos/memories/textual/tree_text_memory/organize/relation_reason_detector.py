import json
import traceback

from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.item import GraphDBNode
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TreeNodeTextualMemoryMetadata
from memos.templates.tree_reorganize_prompts import (
    AGGREGATE_PROMPT,
    INFER_FACT_PROMPT,
    PAIRWISE_RELATION_PROMPT,
)


logger = get_logger(__name__)


class RelationAndReasoningDetector:
    def __init__(self, graph_store: Neo4jGraphDB, llm: BaseLLM, embedder: OllamaEmbedder):
        self.graph_store = graph_store
        self.llm = llm
        self.embedder = embedder

    def process_node(self, node: GraphDBNode, exclude_ids: list[str], top_k: int = 5):
        """
        Unified pipeline for:
        1) Pairwise relations (cause, condition, conflict, relate)
        2) Inferred nodes
        3) Sequence links
        4) Aggregate concepts
        """
        results = {
            "relations": [],
            "inferred_nodes": [],
            "sequence_links": [],
            "aggregate_nodes": [],
        }
        try:
            if node.metadata.type == "reasoning":
                logger.info(f"Skip reasoning for inferred node {node.id}")
                return {
                    "relations": [],
                    "inferred_nodes": [],
                    "sequence_links": [],
                    "aggregate_nodes": [],
                }
            """
            nearest = self.graph_store.get_neighbors_by_tag(
                tags=node.metadata.tags,
                exclude_ids=exclude_ids,
                top_k=top_k,
                min_overlap=2,
            )
            nearest = [GraphDBNode(**cand_data) for cand_data in nearest]

            # 1) Pairwise relations (including CAUSE/CONDITION/CONFLICT)
            pairwise = self._detect_pairwise_causal_condition_relations(node, nearest)
            results["relations"].extend(pairwise["relations"])
            """

            """
            # 2) Inferred nodes (from causal/condition)
            inferred = self._infer_fact_nodes_from_relations(pairwise)
            results["inferred_nodes"].extend(inferred)
            """

            """
            3) Sequence (optional, if you have timestamps)
            seq = self._detect_sequence_links(node, nearest)
            results["sequence_links"].extend(seq)
            """

            """
            # 4) Aggregate
            agg = self._detect_aggregate_node_for_group(node, nearest, min_group_size=5)
            if agg:
                results["aggregate_nodes"].append(agg)
            """

        except Exception as e:
            logger.error(
                f"Error {e} while process struct reorganize: trace: {traceback.format_exc()}"
            )
        return results

    def _detect_pairwise_causal_condition_relations(
        self, node: GraphDBNode, nearest_nodes: list[GraphDBNode]
    ):
        """
        Vector/tag search ➜ For each candidate, use LLM to decide:
        - CAUSE
        - CONDITION
        - RELATE
        - CONFLICT
        """
        results = {"relations": []}

        for candidate in nearest_nodes:
            prompt = PAIRWISE_RELATION_PROMPT.format(
                node1=node.memory,
                node2=candidate.memory,
            )
            response_text = self._call_llm(prompt)
            relation_type = self._parse_relation_result(response_text)
            if relation_type != "NONE":
                results["relations"].append(
                    {
                        "source_id": node.id,
                        "target_id": candidate.id,
                        "relation_type": relation_type,
                    }
                )

        return results

    def _infer_fact_nodes_from_relations(self, pairwise_results: dict):
        inferred_nodes = []
        for rel in pairwise_results["relations"]:
            if rel["relation_type"] in ("CAUSE", "CONDITION"):
                src = self.graph_store.get_node(rel["source_id"])
                tgt = self.graph_store.get_node(rel["target_id"])
                if not src or not tgt:
                    continue

                prompt = INFER_FACT_PROMPT.format(
                    source=src["memory"], target=tgt["memory"], relation_type=rel["relation_type"]
                )
                response_text = self._call_llm(prompt).strip()
                if not response_text:
                    continue
                embedding = self.embedder.embed([response_text])[0]

                inferred_nodes.append(
                    GraphDBNode(
                        memory=response_text,
                        metadata=src["metadata"].__class__(
                            user_id="",
                            session_id="",
                            memory_type="LongTermMemory",
                            status="activated",
                            key=f"InferredFact:{rel['relation_type']}",
                            tags=["inferred"],
                            embedding=embedding,
                            usage=[],
                            sources=[src["id"], tgt["id"]],
                            background=f"Inferred from {rel['relation_type']}",
                            confidence=0.9,
                            type="reasoning",
                        ),
                    )
                )
        return inferred_nodes

    def _detect_sequence_links(self, node: GraphDBNode, nearest_nodes: list[GraphDBNode]):
        """
        If node has timestamp, find other nodes to link FOLLOWS edges.
        """
        results = []
        # Pseudo: find older/newer events with same tags
        # TODO: add time sequence recall
        neighbors = nearest_nodes
        for cand in neighbors:
            # Compare timestamps
            if cand.metadata.updated_at < node.metadata.updated_at:
                results.append({"from_id": cand.id, "to_id": node.id})
            elif cand.metadata.updated_at > node.metadata.updated_at:
                results.append({"from_id": node.id, "to_id": cand.id})
        return results

    def _detect_aggregate_node_for_group(
        self, node: GraphDBNode, nearest_nodes: list[GraphDBNode], min_group_size: int = 3
    ):
        """
        If nodes share overlapping tags, LLM checks if they should be summarized into a new concept.
        """
        if len(nearest_nodes) < min_group_size:
            return None
        combined_nodes = [node, *nearest_nodes]

        joined = "\n".join(f"- {n.memory}" for n in combined_nodes)
        prompt = AGGREGATE_PROMPT.replace("{joined}", joined)
        response_text = self._call_llm(prompt)
        summary = self._parse_json_result(response_text)
        if not summary:
            return None
        embedding = self.embedder.embed([summary["value"]])[0]

        parent_node = GraphDBNode(
            memory=summary["value"],
            metadata=TreeNodeTextualMemoryMetadata(
                user_id="",  # TODO: summarized node: no user_id
                session_id="",  # TODO: summarized node: no session_id
                memory_type=node.metadata.memory_type,
                status="activated",
                key=summary["key"],
                tags=summary.get("tags", []),
                embedding=embedding,
                usage=[],
                sources=[n.id for n in nearest_nodes],
                background=summary.get("background", ""),
                confidence=0.99,
                type="reasoning",
            ),
        )
        return parent_node

    def _call_llm(self, prompt: str) -> str:
        messages = [{"role": "user", "content": prompt}]
        try:
            response = self.llm.generate(messages).strip()
            logger.debug(f"[LLM Raw] {response}")
            return response
        except Exception as e:
            logger.warning(f"[LLM Error] {e}")
            return ""

    def _parse_json_result(self, response_text):
        try:
            response_text = response_text.replace("```", "").replace("json", "")
            response_json = json.loads(response_text)
            return response_json
        except json.JSONDecodeError:
            return {}

    def _parse_relation_result(self, response_text: str) -> str:
        """
        Normalize and validate the LLM relation type output.
        """
        relation = response_text.strip().upper()
        valid = {"CAUSE", "CONDITION", "RELATE", "CONFLICT", "NONE"}
        if relation not in valid:
            logger.warning(
                f"[RelationDetector] Unexpected relation type: {relation}. Fallback to NONE."
            )
            return "NONE"
        return relation
