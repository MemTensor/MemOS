import json
import uuid

from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any

from memos.memories.textual.prefer_text_memory.clustering import ClusterResult, HDBSCANClusterer
from memos.vec_dbs.item import MilvusVecDBItem


class BaseUpdater(ABC):
    """Abstract base class for updaters."""

    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None, extractor=None):
        """Initialize the updater."""


class NaiveUpdater(BaseUpdater):
    """Naive updater."""

    def __init__(self, llm_provider=None, embedder=None, vector_db=None, extractor=None):
        """Initialize the naive updater."""
        super().__init__(llm_provider, embedder, vector_db, extractor)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db
        self.extractor = extractor
        self.clusterer = HDBSCANClusterer()

    def _topic_cluster(self, informations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Topic cluster."""
        vectors = [info.get("topic_vector") for info in informations]
        if not vectors:
            return []
        res = self.clusterer.cluster(vectors)
        for cluster in res:
            cluster.center_dialog_str = informations[cluster.center_index].get("dialog_str", "")
        return res

    def _create_cluster_extract_input(
        self,
        cluster_results: list[ClusterResult],
        informations: list[dict[str, Any]],
        input_type: str,
        k: int = 5,
    ) -> dict[str, list[str]]:
        """Create cluster extract input.
        Args:
            cluster_results: List[ClusterResult]
            informations: List[Dict[str, Any]] containing dialog information
            input_type: str, "original" or "knn"
            k: int, number of nearest neighbors for knn mode
        Returns:
            Dict[str, List[str]] - cluster_id -> list of dialog strings
        """
        result = {}
        if not cluster_results:
            return result

        if input_type == "original":
            # Use all original data in each cluster
            for cluster in cluster_results:
                cluster_dialogs = []
                for item in cluster.items:
                    # item contains {"vector": ..., "index": ...}
                    original_index = item["index"]
                    dialog_str = informations[original_index].get("dialog_str", "")
                    cluster_dialogs.append(dialog_str)
                if cluster_dialogs:
                    result[cluster.cluster_id] = cluster_dialogs

        elif input_type == "knn":
            # Use knn search from cluster center to find k nearest neighbors
            for cluster in cluster_results:
                # Extract all vectors from items in this cluster
                item_vectors = [item["vector"] for item in cluster.items]

                if not item_vectors:
                    result[cluster.cluster_id] = []
                    continue

                # Use clusterer to find k nearest neighbors to cluster center
                knn_results = self.clusterer.search_knn_by_center_embeddings(
                    center_emb=cluster.center_vector,
                    vectors=item_vectors,
                    top_k=min(k, len(item_vectors)),
                )

                # Get dialog strings for knn results
                cluster_dialogs = []
                for knn_item in knn_results:
                    # knn_item contains {"index": idx_in_item_vectors, "distance": ..., "vector": ...}
                    item_idx = knn_item["index"]  # index in item_vectors
                    original_index = cluster.items[item_idx][
                        "index"
                    ]  # original index in informations
                    dialog_str = informations[original_index].get("dialog_str", "")
                    cluster_dialogs.append(dialog_str)
                if cluster_dialogs:
                    result[cluster.cluster_id] = cluster_dialogs

        else:
            raise ValueError(f"Invalid input type: {input_type}")

        return result

    def _process_single_topic_cluster(
        self, cluster_id: str, cluster_dialogs: list[str]
    ) -> dict[str, Any]:
        """Process a single topic cluster."""
        try:
            result = self.extractor.extract_topic_preference(cluster_dialogs)
            return {"cluster_id": cluster_id, "topic_exract_result": result}
        except Exception as e:
            print(f"Error processing topic cluster {cluster_id}: {e}")
            return {"cluster_id": cluster_id, "topic_exract_result": None}

    def _extract_topic_preference(
        self, topic_extract_inputs: dict[str, list[str]], max_workers: int = 10
    ) -> dict[str, dict[str, Any]]:
        """Extract topic preferences from topic extract inputs using thread pool."""
        if not topic_extract_inputs:
            return {}

        results = {}
        with ThreadPoolExecutor(
            max_workers=min(max_workers, len(topic_extract_inputs))
        ) as executor:
            futures = [
                executor.submit(self._process_single_topic_cluster, cluster_id, cluster_dialogs)
                for cluster_id, cluster_dialogs in topic_extract_inputs.items()
            ]

            for future in as_completed(futures):
                try:
                    result = future.result()
                    if result["topic_exract_result"] is not None:
                        cluster_id = result["cluster_id"]
                        results[cluster_id] = result["topic_exract_result"]
                except Exception as e:
                    print(f"Error processing topic cluster: {e}")
                    continue

        return results

    def _extract_user_preference(
        self, topic_cluster_pref_infos: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Extract user preferences from topic cluster info."""
        # topic_prefs is a dict, so we just pass the values as a list
        topic_cluster_pref = list(topic_cluster_pref_infos.values())
        return self.extractor.extract_user_preference(topic_cluster_pref)

    def _store_preferences(
        self,
        topic_clusters,
        topic_cluster_prefs,
        user_prefs,
        user_id,
    ):
        """Create store data."""
        topic_memories = []

        if topic_clusters:
            for cluster in topic_clusters:
                if cluster.cluster_id not in topic_cluster_prefs:
                    print(
                        f"Warning: No preference found for topic cluster {cluster.cluster_id}, skipping..."
                    )
                    continue
                pref = topic_cluster_prefs[cluster.cluster_id]
                mem = MilvusVecDBItem(
                    id=cluster.cluster_id,
                    memory=cluster.center_dialog_str,
                    vector=cluster.center_vector,
                    payload={
                        "cluster_id": cluster.cluster_id,
                        "topic_cluster_name": pref.get("topic_cluster_name", ""),
                        "topic_cluster_description": pref.get("topic_cluster_description", ""),
                        "topic_preference": pref.get("topic_preference", ""),
                        "created_at": cluster.created_at,
                        "user_id": user_id,
                        "size": cluster.size,
                        "preference_type": "topic_preference",
                    },
                )
                topic_memories.append(mem)

            self.vector_db.add("topic_preference", topic_memories)

        if user_prefs:
            mem = MilvusVecDBItem(
                id=str(uuid.uuid4()),
                vector=[0.0] * self.vector_db.config.vector_dimension,
                payload={
                    "user_id": user_id,
                    "user_preference": user_prefs.get("user_preference", ""),
                    "created_at": datetime.now().isoformat(),
                    "preference_type": "user_preference",
                },
            )
            self.vector_db.add("user_preference", [mem])

    def _generate_memory_summary(
        self,
        explicit_infos: list[dict[str, Any]],
        topic_infos: list[dict[str, Any]],
        user_infos: dict[str, Any],
    ) -> str:
        """Generate a summary of the built memory."""
        summary = {
            "memory_build_summary": {
                "explicit_preference_count": len(explicit_infos),
                "topic_preference_count": len(topic_infos),
                "user_preference_count": 1 if user_infos else 0,
                "build_timestamp": datetime.now().isoformat(),
            }
        }

        return json.dumps(summary, ensure_ascii=False, indent=2)

    def slow_update(self, user_id: str):
        """Retrieve all dialog info from the expicit preference collection,
        and reconstruct the implicit preference collection, topic collection and user preference collection.
        """

        # refresh the topic collection and user preference collection
        topic_ids = [
            item.id
            for item in self.vector_db.get_by_filter(
                collection_name="topic_preference", filter={"user_id": user_id}
            )
        ]
        user_ids = [
            item.id
            for item in self.vector_db.get_by_filter(
                collection_name="user_preference", filter={"user_id": user_id}
            )
        ]

        self.vector_db.delete("topic_preference", topic_ids)
        self.vector_db.delete("user_preference", user_ids)

        # get all data from explicit preference collection
        all_data = self.vector_db.get_by_filter("explicit_preference", filter={"user_id": user_id})
        informations = [item.payload for item in all_data]

        # Perform clustering
        topic_clusters = self._topic_cluster(informations)

        # create extract inputs for each implicit and topic cluster
        topic_extract_inputs = self._create_cluster_extract_input(
            topic_clusters, informations, "original"
        )

        # Extract preferences
        if topic_extract_inputs:
            topic_cluster_prefs = self._extract_topic_preference(topic_extract_inputs)

            # Extract user preferences
            user_prefs = self._extract_user_preference(topic_cluster_prefs)

        # Store all preferences in memory
        self._store_preferences(
            topic_clusters=topic_clusters,
            topic_cluster_prefs=topic_cluster_prefs,
            user_prefs=user_prefs,
            user_id=user_id,
        )

        # Return summary of built memory
        return self._generate_memory_summary(
            explicit_infos=informations,
            topic_infos=topic_clusters,
            user_infos=user_prefs,
        )
