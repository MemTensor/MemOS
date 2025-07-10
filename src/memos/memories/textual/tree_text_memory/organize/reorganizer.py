import json
import threading
import time
import traceback

from concurrent.futures import ThreadPoolExecutor, as_completed
from queue import PriorityQueue
from typing import Literal

import numpy as np
import schedule

from sklearn.cluster import MiniBatchKMeans

from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.item import GraphDBEdge, GraphDBNode
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.conflict import ConflictHandler
from memos.memories.textual.tree_text_memory.organize.redundancy import RedundancyHandler
from memos.memories.textual.tree_text_memory.organize.relation_reason_detector import (
    RelationAndReasoningDetector,
)
from memos.templates.tree_reorganize_prompts import LOCAL_SUBCLUSTER_PROMPT, REORGANIZE_PROMPT


logger = get_logger(__name__)


class QueueMessage:
    def __init__(
        self,
        op: Literal["add", "remove", "merge", "update"],
        # `str` for node and edge IDs, `GraphDBNode` and `GraphDBEdge` for actual objects
        before_node: list[str] | list[GraphDBNode] | None = None,
        before_edge: list[str] | list[GraphDBEdge] | None = None,
        after_node: list[str] | list[GraphDBNode] | None = None,
        after_edge: list[str] | list[GraphDBEdge] | None = None,
    ):
        self.op = op
        self.before_node = before_node
        self.before_edge = before_edge
        self.after_node = after_node
        self.after_edge = after_edge

    def __str__(self) -> str:
        return f"QueueMessage(op={self.op}, before_node={self.before_node if self.before_node is None else len(self.before_node)}, after_node={self.after_node if self.after_node is None else len(self.after_node)})"

    def __lt__(self, other: "QueueMessage") -> bool:
        op_priority = {"add": 2, "remove": 2, "merge": 1}
        return op_priority[self.op] < op_priority[other.op]


class GraphStructureReorganizer:
    def __init__(
        self, graph_store: Neo4jGraphDB, llm: BaseLLM, embedder: OllamaEmbedder, is_reorganize: bool
    ):
        self.queue = PriorityQueue()  # Min-heap
        self.graph_store = graph_store
        self.llm = llm
        self.embedder = embedder
        self.relation_detector = RelationAndReasoningDetector(
            self.graph_store, self.llm, self.embedder
        )
        self.conflict = ConflictHandler(graph_store=graph_store, llm=llm, embedder=embedder)
        self.redundancy = RedundancyHandler(graph_store=graph_store, llm=llm, embedder=embedder)

        self.is_reorganize = is_reorganize
        if self.is_reorganize:
            # ____ 1. For queue message driven thread ___________
            self.thread = threading.Thread(target=self._run_message_consumer_loop)
            self.thread.start()
            # ____ 2. For periodic structure optimization _______
            self._stop_scheduler = False
            self._is_optimizing = {"LongTermMemory": False, "UserMemory": False}
            self.structure_optimizer_thread = threading.Thread(
                target=self._run_structure_organizer_loop
            )
            self.structure_optimizer_thread.start()

    def add_message(self, message: QueueMessage):
        self.queue.put_nowait(message)

    def wait_until_current_task_done(self):
        """
        Wait until:
        1) queue is empty
        2) any running structure optimization is done
        """
        if not self.is_reorganize:
            return

        if not self.queue.empty():
            self.queue.join()
        logger.debug("Queue is now empty.")

        while any(self._is_optimizing.values()):
            logger.debug(f"Waiting for structure optimizer to finish... {self._is_optimizing}")
            time.sleep(1)
        logger.debug("Structure optimizer is now idle.")

    def _run_message_consumer_loop(self):
        while True:
            message = self.queue.get()
            if message is None:
                break

            try:
                if self._preprocess_message(message):
                    self.handle_message(message)
            except Exception:
                logger.error(traceback.format_exc())
            self.queue.task_done()

    def _run_structure_organizer_loop(self):
        """
        Use schedule library to periodically trigger structure optimization.
        This runs until the stop flag is set.
        """
        schedule.every(20).seconds.do(self.optimize_structure, scope="LongTermMemory")
        schedule.every(20).seconds.do(self.optimize_structure, scope="UserMemory")

        logger.info("Structure optimizer schedule started.")
        while not getattr(self, "_stop_scheduler", False):
            schedule.run_pending()
            time.sleep(1)

    def stop(self):
        """
        Stop the reorganizer thread.
        """
        if not self.is_reorganize:
            return

        self.add_message(None)
        self.thread.join()
        logger.info("Reorganize thread stopped.")
        self._stop_scheduler = True
        self.structure_optimizer_thread.join()
        logger.info("Structure optimizer stopped.")

    def handle_message(self, message: QueueMessage):
        handle_map = {
            "add": self.handle_add,
            "remove": self.handle_remove,
            "merge": self.handle_merge,
        }
        handle_map[message.op](message)
        logger.debug(f"message queue size: {self.queue.qsize()}")

    def handle_add(self, message: QueueMessage):
        logger.debug(f"Handling add operation: {str(message)[:500]}")
        assert message.before_node is None and message.before_edge is None, (
            "Before node and edge should be None for `add` operation."
        )
        # ———————— 1. check for conflicts ————————
        added_node = message.after_node[0]
        conflicts = self.conflict.detect(added_node, scope=added_node.metadata.memory_type)
        if conflicts:
            for added_node, existing_node in conflicts:
                self.conflict.resolve(added_node, existing_node)
                logger.info(f"Resolved conflict between {added_node.id} and {existing_node.id}.")

        # ———————— 2. check for redundancy ————————
        redundancy = self.redundancy.detect(added_node, scope=added_node.metadata.memory_type)
        if redundancy:
            for added_node, existing_node in redundancy:
                self.redundancy.resolve_two_nodes(added_node, existing_node)
                logger.info(f"Resolved redundancy between {added_node.id} and {existing_node.id}.")

    def handle_remove(self, message: QueueMessage):
        logger.debug(f"Handling remove operation: {str(message)[:50]}")

    def handle_merge(self, message: QueueMessage):
        after_node = message.after_node[0]
        logger.debug(f"Handling merge operation: <{after_node.memory}>")
        self.redundancy_resolver.resolve_one_node(after_node)

    def optimize_structure(
        self,
        scope: str = "LongTermMemory",
        local_tree_threshold: int = 10,
        min_cluster_size: int = 3,
        min_group_size: int = 10,
    ):
        """
        Periodically reorganize the graph:
        1. Weakly partition nodes into clusters.
        2. Summarize each cluster.
        3. Create parent nodes and build local PARENT trees.
        """
        if self._is_optimizing[scope]:
            logger.info(f"Already optimizing for {scope}. Skipping.")
            return

        if self.graph_store.count_nodes(scope) == 0:
            logger.debug(f"[GraphStructureReorganize] No nodes for scope={scope}. Skip.")
            return

        self._is_optimizing[scope] = True
        try:
            logger.debug(
                f"[GraphStructureReorganize] 🔍 Starting structure optimization for scope: {scope}"
            )

            logger.debug(
                f"Num of scope in self.graph_store is {self.graph_store.get_memory_count(scope)}"
            )
            # Load candidate nodes
            raw_nodes = self.graph_store.get_structure_optimization_candidates(scope)
            nodes = [GraphDBNode(**n) for n in raw_nodes]

            if not nodes:
                logger.info("[GraphStructureReorganize] No nodes to optimize. Skipping.")
                return

            if len(nodes) < min_group_size:
                logger.info(
                    f"[GraphStructureReorganize] Only {len(nodes)} candidate nodes found. Not enough to reorganize. Skipping."
                )
                return

            logger.info(f"[GraphStructureReorganize] Loaded {len(nodes)} nodes.")

            # Step 2: Partition nodes
            partitioned_groups = self._partition(nodes)

            logger.info(
                f"[GraphStructureReorganize] Partitioned into {len(partitioned_groups)} clusters."
            )

            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = []
                for cluster_nodes in partitioned_groups:
                    futures.append(
                        executor.submit(
                            self._process_cluster_and_write,
                            cluster_nodes,
                            scope,
                            local_tree_threshold,
                            min_cluster_size,
                        )
                    )

                for f in as_completed(futures):
                    try:
                        f.result()
                    except Exception as e:
                        logger.warning(f"[Reorganize] Cluster processing failed: {e}")
                logger.info("[GraphStructure Reorganize] Structure optimization finished.")

        finally:
            self._is_optimizing[scope] = False
            logger.info("[GraphStructureReorganize] Structure optimization finished.")

    def _process_cluster_and_write(
        self,
        cluster_nodes: list[GraphDBNode],
        scope: str,
        local_tree_threshold: int,
        min_cluster_size: int,
    ):
        if len(cluster_nodes) <= min_cluster_size:
            return

        if len(cluster_nodes) <= local_tree_threshold:
            # Small cluster ➜ single parent
            parent_node = self._summarize_cluster(cluster_nodes, scope)
            self._create_parent_node(parent_node)
            self._link_cluster_nodes(parent_node, cluster_nodes)
        else:
            # Large cluster ➜ local sub-clustering
            sub_clusters = self._local_subcluster(cluster_nodes)
            sub_parents = []

            for sub_nodes in sub_clusters:
                if len(sub_nodes) < min_cluster_size:
                    continue  # Skip tiny noise
                sub_parent_node = self._summarize_cluster(sub_nodes, scope)
                self._create_parent_node(sub_parent_node)
                self._link_cluster_nodes(sub_parent_node, sub_nodes)
                sub_parents.append(sub_parent_node)

            if sub_parents:
                cluster_parent_node = self._summarize_cluster(cluster_nodes, scope)
                self._create_parent_node(cluster_parent_node)
                for sub_parent in sub_parents:
                    self.graph_store.add_edge(cluster_parent_node.id, sub_parent.id, "PARENT")

        logger.info("Adding relations/reasons")
        nodes_to_check = cluster_nodes
        exclude_ids = [n.id for n in nodes_to_check]

        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = []
            for node in nodes_to_check:
                futures.append(
                    executor.submit(
                        self.relation_detector.process_node,
                        node,
                        exclude_ids,
                        10,  # top_k
                    )
                )

            for f in as_completed(futures):
                results = f.result()

                # 1) Add pairwise relations
                for rel in results["relations"]:
                    if not self.graph_store.edge_exists(
                        rel["source_id"], rel["target_id"], rel["relation_type"]
                    ):
                        self.graph_store.add_edge(
                            rel["source_id"], rel["target_id"], rel["relation_type"]
                        )

                # 2) Add inferred nodes and link to sources
                for inf_node in results["inferred_nodes"]:
                    self.graph_store.add_node(
                        inf_node.id,
                        inf_node.memory,
                        inf_node.metadata.model_dump(exclude_none=True),
                    )
                    for src_id in inf_node.metadata.sources:
                        self.graph_store.add_edge(src_id, inf_node.id, "INFERS")

                # 3) Add sequence links
                for seq in results["sequence_links"]:
                    if not self.graph_store.edge_exists(seq["from_id"], seq["to_id"], "FOLLOWS"):
                        self.graph_store.add_edge(seq["from_id"], seq["to_id"], "FOLLOWS")

                # 4) Add aggregate concept nodes
                for agg_node in results["aggregate_nodes"]:
                    self.graph_store.add_node(
                        agg_node.id,
                        agg_node.memory,
                        agg_node.metadata.model_dump(exclude_none=True),
                    )
                    for child_id in agg_node.metadata.sources:
                        self.graph_store.add_edge(agg_node.id, child_id, "AGGREGATES")

            logger.info("[Reorganizer] Cluster relation/reasoning done.")

    def _local_subcluster(self, cluster_nodes: list[GraphDBNode]) -> list[list[GraphDBNode]]:
        """
        Use LLM to split a large cluster into semantically coherent sub-clusters.
        """
        if not cluster_nodes:
            return []

        # Prepare conversation-like input: ID + key + value
        scene_lines = []
        for node in cluster_nodes:
            line = f"- ID: {node.id} | Key: {node.metadata.key} | Value: {node.memory}"
            scene_lines.append(line)

        joined_scene = "\n".join(scene_lines)
        prompt = LOCAL_SUBCLUSTER_PROMPT.format(joined_scene=joined_scene)

        messages = [{"role": "user", "content": prompt}]
        response_text = self.llm.generate(messages)
        response_json = self._parse_json_result(response_text)
        assigned_ids = set()
        result_subclusters = []

        for cluster in response_json.get("clusters", []):
            ids = []
            for nid in cluster.get("ids", []):
                if nid not in assigned_ids:
                    ids.append(nid)
                    assigned_ids.add(nid)
            sub_nodes = [node for node in cluster_nodes if node.id in ids]
            if len(sub_nodes) >= 2:
                result_subclusters.append(sub_nodes)

        return result_subclusters

    def _partition(
        self, nodes: list[GraphDBNode], min_cluster_size: int = 3
    ) -> list[list[GraphDBNode]]:
        """
        Partition nodes by:
        1) Frequent tags (top N & above threshold)
        2) Remaining nodes by embedding clustering (MiniBatchKMeans)
        3) Small clusters merged or assigned to 'Other'

        Args:
            nodes: List of GraphDBNode
            min_cluster_size: Min size to keep a cluster as-is

        Returns:
            List of clusters, each as a list of GraphDBNode
        """
        from collections import Counter, defaultdict

        # 1) Count all tags
        tag_counter = Counter()
        for node in nodes:
            for tag in node.metadata.tags:
                tag_counter[tag] += 1

        # Select frequent tags
        top_n_tags = {tag for tag, count in tag_counter.most_common(50)}
        threshold_tags = {tag for tag, count in tag_counter.items() if count >= 50}
        frequent_tags = top_n_tags | threshold_tags

        # Group nodes by tags, ensure each group is unique internally
        tag_groups = defaultdict(list)

        for node in nodes:
            for tag in node.metadata.tags:
                if tag in frequent_tags:
                    tag_groups[tag].append(node)
                    break

        filtered_tag_clusters = []
        assigned_ids = set()
        for tag, group in tag_groups.items():
            if len(group) >= min_cluster_size:
                filtered_tag_clusters.append(group)
                assigned_ids.update(n.id for n in group)
            else:
                logger.info(f"... dropped {tag} ...")

        logger.info(
            f"[MixedPartition] Created {len(filtered_tag_clusters)} clusters from tags. "
            f"Nodes grouped by tags: {len(assigned_ids)} / {len(nodes)}"
        )

        # 5) Remaining nodes -> embedding clustering
        remaining_nodes = [n for n in nodes if n.id not in assigned_ids]
        logger.info(
            f"[MixedPartition] Remaining nodes for embedding clustering: {len(remaining_nodes)}"
        )

        embedding_clusters = []
        if remaining_nodes:
            x = np.array([n.metadata.embedding for n in remaining_nodes if n.metadata.embedding])
            k = max(1, min(len(remaining_nodes) // min_cluster_size, 20))
            if len(x) < k:
                k = len(x)

            if 1 < k <= len(x):
                kmeans = MiniBatchKMeans(n_clusters=k, batch_size=256, random_state=42)
                labels = kmeans.fit_predict(x)

                label_groups = defaultdict(list)
                for node, label in zip(remaining_nodes, labels, strict=False):
                    label_groups[label].append(node)

                embedding_clusters = list(label_groups.values())
                logger.info(
                    f"[MixedPartition] Created {len(embedding_clusters)} clusters from embedding."
                )
            else:
                embedding_clusters = [remaining_nodes]

        # Merge all & handle small clusters
        all_clusters = filtered_tag_clusters + embedding_clusters

        # Optional: merge tiny clusters
        final_clusters = []
        small_nodes = []
        for group in all_clusters:
            if len(group) < min_cluster_size:
                small_nodes.extend(group)
            else:
                final_clusters.append(group)

        if small_nodes:
            final_clusters.append(small_nodes)
            logger.info(f"[MixedPartition] {len(small_nodes)} nodes assigned to 'Other' cluster.")

        logger.info(f"[MixedPartition] Total final clusters: {len(final_clusters)}")
        return final_clusters

    def _summarize_cluster(self, cluster_nodes: list[GraphDBNode], scope: str) -> GraphDBNode:
        """
        Generate a cluster label using LLM, based on top keys in the cluster.
        """
        if not cluster_nodes:
            raise ValueError("Cluster nodes cannot be empty.")

        joined_keys = "\n".join(f"- {n.metadata.key}" for n in cluster_nodes if n.metadata.key)
        joined_values = "\n".join(f"- {n.memory}" for n in cluster_nodes)
        joined_backgrounds = "\n".join(
            f"- {n.metadata.background}" for n in cluster_nodes if n.metadata.background
        )

        # Build prompt
        prompt = REORGANIZE_PROMPT.format(
            joined_keys=joined_keys,
            joined_values=joined_values,
            joined_backgrounds=joined_backgrounds,
        )

        messages = [{"role": "user", "content": prompt}]
        response_text = self.llm.generate(messages)
        response_json = self._parse_json_result(response_text)

        # Extract fields
        parent_key = response_json.get("key", "").strip()
        parent_value = response_json.get("value", "").strip()
        parent_tags = response_json.get("tags", [])
        parent_background = response_json.get("background", "").strip()

        embedding = self.embedder.embed([parent_value])[0]

        parent_node = GraphDBNode(
            memory=parent_value,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id="",  # TODO: summarized node: no user_id
                session_id="",  # TODO: summarized node: no session_id
                memory_type=scope,
                status="activated",
                key=parent_key,
                tags=parent_tags,
                embedding=embedding,
                usage=[],
                sources=[n.id for n in cluster_nodes],
                background=parent_background,
                confidence=0.99,
                type="topic",
            ),
        )
        return parent_node

    def _parse_json_result(self, response_text):
        try:
            response_text = response_text.replace("```", "").replace("json", "")
            response_json = json.loads(response_text)
            return response_json
        except json.JSONDecodeError as e:
            logger.warning(
                f"Failed to parse LLM response as JSON: {e}\nRaw response:\n{response_text}"
            )
            return {}

    def _create_parent_node(self, parent_node: GraphDBNode) -> None:
        """
        Create a new parent node for the cluster.
        """
        self.graph_store.add_node(
            parent_node.id,
            parent_node.memory,
            parent_node.metadata.model_dump(exclude_none=True),
        )

    def _link_cluster_nodes(self, parent_node: GraphDBNode, child_nodes: list[GraphDBNode]):
        """
        Add PARENT edges from the parent node to all nodes in the cluster.
        """
        for child in child_nodes:
            if not self.graph_store.edge_exists(
                parent_node.id, child.id, "PARENT", direction="OUTGOING"
            ):
                self.graph_store.add_edge(parent_node.id, child.id, "PARENT")

    def _preprocess_message(self, message: QueueMessage) -> bool:
        message = self._convert_id_to_node(message)
        if None in message.after_node:
            logger.debug(
                f"Found non-existent node in after_node in message: {message}, skip this message."
            )
            return False
        return True

    def _convert_id_to_node(self, message: QueueMessage) -> QueueMessage:
        """
        Convert IDs in the message.after_node to GraphDBNode objects.
        """
        for i, node in enumerate(message.after_node or []):
            if not isinstance(node, str):
                continue
            raw_node = self.graph_store.get_node(node)
            if raw_node is None:
                logger.debug(f"Node with ID {node} not found in the graph store.")
                message.after_node[i] = None
            else:
                message.after_node[i] = GraphDBNode(**raw_node)
        return message
