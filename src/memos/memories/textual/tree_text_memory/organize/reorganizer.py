import json
import threading
import time
import traceback

from collections import defaultdict
from concurrent.futures import as_completed
from queue import PriorityQueue
from typing import Literal

import numpy as np

from memos.context.context import ContextThreadPoolExecutor
from memos.dependency import require_python_package
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.item import GraphDBEdge, GraphDBNode
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import SourceMessage, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.handler import NodeHandler
from memos.memories.textual.tree_text_memory.organize.relation_reason_detector import (
    RelationAndReasoningDetector,
)
from memos.templates.tree_reorganize_prompts import LOCAL_SUBCLUSTER_PROMPT, REORGANIZE_PROMPT


logger = get_logger(__name__)


def build_summary_parent_node(cluster_nodes):
    normalized_sources = []
    for n in cluster_nodes:
        sm = SourceMessage(
            type="chat",
            role=None,
            chat_time=None,
            message_id=None,
            content=n.memory,
            # extra
            node_id=n.id,
        )
        normalized_sources.append(sm)
    return normalized_sources


class QueueMessage:
    def __init__(
        self,
        op: Literal["add", "remove", "merge", "update", "end"],
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
        op_priority = {"add": 2, "remove": 2, "merge": 1, "end": 0}
        return op_priority[self.op] < op_priority[other.op]


def extract_first_to_last_brace(text: str):
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return "", None
    json_str = text[start : end + 1]
    return json_str, json.loads(json_str)


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
        self.resolver = NodeHandler(graph_store=graph_store, llm=llm, embedder=embedder)

        self.is_reorganize = is_reorganize
        self._reorganize_needed = True
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
        deadline = time.time() + 600
        if not self.is_reorganize:
            return

        if not self.queue.empty():
            self.queue.join()
        logger.debug("Queue is now empty.")

        while any(self._is_optimizing.values()):
            logger.debug(f"Waiting for structure optimizer to finish... {self._is_optimizing}")
            if time.time() > deadline:
                logger.error(f"Wait timed out; flags={self._is_optimizing}")
                break
            time.sleep(1)
        logger.debug("Structure optimizer is now idle.")

    def _run_message_consumer_loop(self):
        while True:
            message = self.queue.get()
            if message.op == "end":
                break

            try:
                if self._preprocess_message(message):
                    self.handle_message(message)
            except Exception:
                logger.error(traceback.format_exc())
            self.queue.task_done()

    @require_python_package(
        import_name="schedule",
        install_command="pip install schedule",
        install_link="https://schedule.readthedocs.io/en/stable/installation.html",
    )
    def _run_structure_organizer_loop(self):
        """
        Use schedule library to periodically trigger structure optimization.
        This runs until the stop flag is set.
        """
        import schedule

        schedule.every(100).seconds.do(self.optimize_structure, scope="LongTermMemory")
        schedule.every(100).seconds.do(self.optimize_structure, scope="UserMemory")

        logger.info("Structure optimizer schedule started.")
        while not getattr(self, "_stop_scheduler", False):
            if any(self._is_optimizing.values()):
                time.sleep(1)
                continue
            if self._reorganize_needed:
                logger.info("[Reorganizer] Triggering optimize_structure due to new nodes.")
                self.optimize_structure(scope="LongTermMemory")
                self.optimize_structure(scope="UserMemory")
                self._reorganize_needed = False
            time.sleep(30)

    def stop(self):
        """
        Stop the reorganizer thread.
        """
        if not self.is_reorganize:
            return

        self.add_message(QueueMessage(op="end"))
        self.thread.join()
        logger.info("Reorganize thread stopped.")
        self._stop_scheduler = True
        self.structure_optimizer_thread.join()
        logger.info("Structure optimizer stopped.")

    def handle_message(self, message: QueueMessage):
        handle_map = {"add": self.handle_add, "remove": self.handle_remove}
        handle_map[message.op](message)
        logger.debug(f"message queue size: {self.queue.qsize()}")

    def handle_add(self, message: QueueMessage):
        logger.debug(f"Handling add operation: {str(message)[:500]}")
        added_node = message.after_node[0]
        detected_relationships = self.resolver.detect(
            added_node, scope=added_node.metadata.memory_type
        )
        if detected_relationships:
            for added_node, existing_node, relation in detected_relationships:
                self.resolver.resolve(added_node, existing_node, relation)

        self._reorganize_needed = True

    def handle_remove(self, message: QueueMessage):
        logger.debug(f"Handling remove operation: {str(message)[:50]}")

    def optimize_structure(
        self,
        scope: str = "LongTermMemory",
        local_tree_threshold: int = 10,
        min_cluster_size: int = 4,
        min_group_size: int = 20,
        max_duration_sec: int = 600,
    ):
        """
        Periodically reorganize the graph:
        1. Weakly partition nodes into clusters.
        2. Summarize each cluster.
        3. Create parent nodes and build local PARENT trees.
        """
        # --- Total time watch dog: check functions ---
        start_ts = time.time()

        def _check_deadline(where: str):
            if time.time() - start_ts > max_duration_sec:
                logger.error(
                    f"[GraphStructureReorganize] {scope} surpass {max_duration_sec}s，time "
                    f"over at {where}"
                )
                return True
            return False

        if self._is_optimizing[scope]:
            logger.info(f"[GraphStructureReorganize] Already optimizing for {scope}. Skipping.")
            return

        if self.graph_store.node_not_exist(scope):
            logger.debug(f"[GraphStructureReorganize] No nodes for scope={scope}. Skip.")
            return

        self._is_optimizing[scope] = True
        try:
            logger.debug(
                f"[GraphStructureReorganize] 🔍 Starting structure optimization for scope: {scope}"
            )

            logger.debug(
                f"[GraphStructureReorganize] Num of scope in self.graph_store is"
                f" {self.graph_store.get_memory_count(scope)}"
            )
            # Load candidate nodes
            if _check_deadline("[GraphStructureReorganize] Before loading candidates"):
                return
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

            # Step 2: Partition nodes
            if _check_deadline("[GraphStructureReorganize] Before partition"):
                return
            partitioned_groups = self._partition(nodes)
            logger.info(
                f"[GraphStructureReorganize] Partitioned into {len(partitioned_groups)} clusters."
            )

            if _check_deadline("[GraphStructureReorganize] Before submit partition task"):
                return
            with ContextThreadPoolExecutor(max_workers=4) as executor:
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
                    if _check_deadline("[GraphStructureReorganize] Waiting clusters..."):
                        for x in futures:
                            x.cancel()
                        return
                    try:
                        f.result()
                    except Exception as e:
                        logger.warning(
                            f"[GraphStructureReorganize] Cluster processing failed: {e}, trace: {traceback.format_exc()}"
                        )
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

        if sub_parents and len(sub_parents) >= min_cluster_size:
            cluster_parent_node = self._summarize_cluster(cluster_nodes, scope)
            self._create_parent_node(cluster_parent_node)
            for sub_parent in sub_parents:
                self.graph_store.add_edge(cluster_parent_node.id, sub_parent.id, "PARENT")

        logger.info("Adding relations/reasons")
        nodes_to_check = cluster_nodes
        exclude_ids = [n.id for n in nodes_to_check]

        with ContextThreadPoolExecutor(max_workers=4) as executor:
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

            for f in as_completed(futures, timeout=300):
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
                        self.graph_store.add_edge(agg_node.id, child_id, "AGGREGATE_TO")

        logger.info("[Reorganizer] Cluster relation/reasoning done.")

    def _local_subcluster(
        self, cluster_nodes: list[GraphDBNode], max_length: int = 15000
    ) -> list[list[GraphDBNode]]:
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
        if len(joined_scene) > max_length:
            logger.warning("Sub-cluster too long")
        prompt = LOCAL_SUBCLUSTER_PROMPT.replace("{joined_scene}", joined_scene[:max_length])

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

    @require_python_package(
        import_name="sklearn",
        install_command="pip install scikit-learn",
        install_link="https://scikit-learn.org/stable/install.html",
    )
    def _partition(self, nodes, min_cluster_size: int = 10, max_cluster_size: int = 20):
        """
        Partition nodes by:
        - If total nodes <= max_cluster_size -> return all nodes in one cluster.
        - If total nodes > max_cluster_size -> cluster by embeddings, recursively split.
        - Only keep clusters with size > min_cluster_size.

        Args:
            nodes: List of GraphDBNode
            min_cluster_size: Min size to keep a cluster as-is

        Returns:
            List of clusters, each as a list of GraphDBNode
        """
        from sklearn.cluster import MiniBatchKMeans

        if len(nodes) <= max_cluster_size:
            logger.info(
                f"[KMeansPartition] Node count {len(nodes)} <= {max_cluster_size}, skipping KMeans."
            )
            return [nodes]

        def recursive_clustering(nodes_list, depth=0):
            """Recursively split clusters until each is <= max_cluster_size."""
            indent = "  " * depth
            logger.info(
                f"{indent}[Recursive] Start clustering {len(nodes_list)} nodes at depth {depth}"
            )

            if len(nodes_list) <= max_cluster_size:
                logger.info(
                    f"{indent}[Recursive] Node count <= {max_cluster_size}, stop splitting."
                )
                return [nodes_list]
            # Try kmeans with k = ceil(len(nodes) / max_cluster_size)
            x_nodes = [n for n in nodes_list if n.metadata.embedding]
            x = np.array([n.metadata.embedding for n in x_nodes])

            if len(x) < min_cluster_size:
                logger.info(
                    f"{indent}[Recursive] Too few embeddings ({len(x)}), skipping clustering."
                )
                return [nodes_list]

            k = min(len(x), (len(nodes_list) + max_cluster_size - 1) // max_cluster_size)
            k = max(1, k)

            try:
                logger.info(f"{indent}[Recursive] Clustering with k={k} on {len(x)} points.")
                kmeans = MiniBatchKMeans(n_clusters=k, batch_size=256, random_state=42)
                labels = kmeans.fit_predict(x)

                label_groups = defaultdict(list)
                for node, label in zip(x_nodes, labels, strict=False):
                    label_groups[label].append(node)

                # Map: label -> nodes with no embedding (fallback group)
                no_embedding_nodes = [n for n in nodes_list if not n.metadata.embedding]
                if no_embedding_nodes:
                    logger.warning(
                        f"{indent}[Recursive] {len(no_embedding_nodes)} nodes have no embedding. Added to largest cluster."
                    )
                    # Assign to largest cluster
                    largest_label = max(label_groups.items(), key=lambda kv: len(kv[1]))[0]
                    label_groups[largest_label].extend(no_embedding_nodes)

                result = []
                for label, sub_group in label_groups.items():
                    logger.info(f"{indent}  Cluster-{label}: {len(sub_group)} nodes")
                    result.extend(recursive_clustering(sub_group, depth=depth + 1))
                return result

            except Exception as e:
                logger.warning(
                    f"{indent}[Recursive] Clustering failed: {e}, fallback to one cluster."
                )
                return [nodes_list]

        raw_clusters = recursive_clustering(nodes)
        filtered_clusters = [c for c in raw_clusters if len(c) > min_cluster_size]

        logger.info(f"[KMeansPartition] Total clusters before filtering: {len(raw_clusters)}")
        for i, cluster in enumerate(raw_clusters):
            logger.info(f"[KMeansPartition]   Cluster-{i}: {len(cluster)} nodes")

        logger.info(
            f"[KMeansPartition] Clusters after filtering (>{min_cluster_size}): {len(filtered_clusters)}"
        )

        return filtered_clusters

    def _summarize_cluster(self, cluster_nodes: list[GraphDBNode], scope: str) -> GraphDBNode:
        """
        Generate a cluster label using LLM, based on top keys in the cluster.
        """
        if not cluster_nodes:
            raise ValueError("Cluster nodes cannot be empty.")

        memories_items_text = "\n\n".join(
            [
                f"{i}. key: {n.metadata.key}\nvalue: {n.memory}\nsummary:{n.metadata.background}"
                for i, n in enumerate(cluster_nodes)
            ]
        )

        # Build prompt
        prompt = REORGANIZE_PROMPT.replace("{memory_items_text}", memories_items_text)

        messages = [{"role": "user", "content": prompt}]
        response_text = self.llm.generate(messages)
        response_json = self._parse_json_result(response_text)

        # Extract fields
        parent_key = response_json.get("key", "").strip()
        parent_value = response_json.get("value", "").strip()
        parent_tags = response_json.get("tags", [])
        parent_background = response_json.get("summary", "").strip()

        embedding = self.embedder.embed([parent_value])[0]

        parent_node = GraphDBNode(
            memory=parent_value,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=None,
                session_id=None,
                memory_type=scope,
                status="activated",
                key=parent_key,
                tags=parent_tags,
                embedding=embedding,
                usage=[],
                sources=build_summary_parent_node(cluster_nodes),
                background=parent_background,
                confidence=0.66,
                type="topic",
            ),
        )
        return parent_node

    def _parse_json_result(self, response_text):
        try:
            response_text = response_text.replace("```", "").replace("json", "")
            response_json = extract_first_to_last_brace(response_text)[1]
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
        if message.after_node is None or None in message.after_node:
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
            raw_node = self.graph_store.get_node(node, include_embedding=True)
            if raw_node is None:
                logger.debug(f"Node with ID {node} not found in the graph store.")
                message.after_node[i] = None
            else:
                message.after_node[i] = GraphDBNode(**raw_node)
        return message
