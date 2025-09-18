from abc import ABC, abstractmethod
from typing import Any, List, Dict
from datetime import datetime
import uuid
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from memos.types import MessageList
from memos.vec_dbs.item import VecDBItem
from memos.memories.textual.prefer_text_memory.clustering import HDBSCANClusterer, ClusterResult


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

    def _implicit_cluster(self, informations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Implicit cluster."""
        vectors = [info.get("dialog_vector") for info in informations]
        if not vectors:
            return []
        res = self.clusterer.cluster(vectors)
        for cluster in res:
            cluster.center_dialog_msgs = informations[cluster.center_index].get("dialog_msgs", [])
            cluster.center_dialog_str = informations[cluster.center_index].get("dialog_str", "")
        return res
        
    def _topic_cluster(self, informations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Topic cluster."""
        vectors = [info.get("topic_vector") for info in informations]
        if not vectors:
            return []
        res = self.clusterer.cluster(vectors)
        for cluster in res:
            cluster.center_dialog_msgs = informations[cluster.center_index].get("dialog_msgs", [])
            cluster.center_dialog_str = informations[cluster.center_index].get("dialog_str", "")
        return res

    def _create_cluster_extract_input(self, cluster_results: List[ClusterResult], informations: List[Dict[str, Any]], input_type: str, k: int = 5) -> Dict[str, List[str]]:
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
                    top_k=min(k, len(item_vectors))
                )
                
                # Get dialog strings for knn results
                cluster_dialogs = []
                for knn_item in knn_results:
                    # knn_item contains {"index": idx_in_item_vectors, "distance": ..., "vector": ...}
                    item_idx = knn_item["index"]  # index in item_vectors
                    original_index = cluster.items[item_idx]["index"]  # original index in informations
                    dialog_str = informations[original_index].get("dialog_str", "")
                    cluster_dialogs.append(dialog_str)
                if cluster_dialogs:
                    result[cluster.cluster_id] = cluster_dialogs
                
        else:
            raise ValueError(f"Invalid input type: {input_type}")
            
        return result

    def _process_single_implicit_cluster(self, cluster_id: str, cluster_dialogs: List[str]) -> Dict[str, Any]:
        """Process a single implicit cluster."""
        try:
            result = self.extractor.extract_implicit_preferences(cluster_dialogs)
            return {"cluster_id": cluster_id, "implicit_exract_result": result}
        except Exception as e:
            print(f"Error processing implicit cluster {cluster_id}: {e}")
            return {"cluster_id": cluster_id, "implicit_exract_result": None}

    def _extract_implicit_preferences(self, implicit_extract_inputs: Dict[str, List[str]], max_workers: int = 10) -> Dict[str, Dict[str, Any]]:
        """Extract implicit preferences from implicit extract inputs using thread pool."""
        if not implicit_extract_inputs:
            return {}
        
        results = {}
        with ThreadPoolExecutor(max_workers=min(max_workers, len(implicit_extract_inputs))) as executor:
            futures = [
                executor.submit(self._process_single_implicit_cluster, cluster_id, cluster_dialogs)
                for cluster_id, cluster_dialogs in implicit_extract_inputs.items()
            ]
            
            for future in as_completed(futures):
                try:
                    result = future.result()
                    if result["implicit_exract_result"] is not None:
                        cluster_id = result["cluster_id"]
                        results[cluster_id] = result["implicit_exract_result"]
                except Exception as e:
                    print(f"Error processing implicit cluster: {e}")
                    continue
        
        return results
    
    def _process_single_topic_cluster(self, cluster_id: str, cluster_dialogs: List[str]) -> Dict[str, Any]:
        """Process a single topic cluster."""
        try:
            result = self.extractor.extract_topic_preferences(cluster_dialogs)
            return {"cluster_id": cluster_id, "topic_exract_result": result}
        except Exception as e:
            print(f"Error processing topic cluster {cluster_id}: {e}")
            return {"cluster_id": cluster_id, "topic_exract_result": None}

    def _extract_topic_preferences(self, topic_extract_inputs: Dict[str, List[str]], max_workers: int = 10) -> Dict[str, Dict[str, Any]]:
        """Extract topic preferences from topic extract inputs using thread pool."""
        if not topic_extract_inputs:
            return {}
        
        results = {}
        with ThreadPoolExecutor(max_workers=min(max_workers, len(topic_extract_inputs))) as executor:
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

    def _extract_user_preferences(self, topic_cluster_pref_infos: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extract user preferences from topic cluster info."""
        # topic_prefs is a dict, so we just pass the values as a list
        topic_cluster_pref = list(topic_cluster_pref_infos.values())
        return self.extractor.extract_user_preferences(topic_cluster_pref)

    def _store_preferences(self, 
                        implicit_clusters, 
                        topic_clusters, 
                        implicit_cluster_prefs,
                        topic_cluster_prefs,
                        user_prefs, 
                        user_id):
        """Create store data."""
        implicit_memories = []
        topic_memories = []

        if implicit_clusters:
            for cluster in implicit_clusters:
                if cluster.cluster_id not in implicit_cluster_prefs:
                    print(f"Warning: No preference found for cluster {cluster.cluster_id}, skipping...")
                    continue
                pref = implicit_cluster_prefs[cluster.cluster_id]
                mem = VecDBItem(
                    id=cluster.cluster_id,
                    vector=cluster.center_vector,
                    payload={
                        "cluster_id": cluster.cluster_id,
                        "center_dialog_msgs": cluster.center_dialog_msgs,
                        "center_dialog_str": cluster.center_dialog_str,
                        "center_vector": cluster.center_vector,
                        "implicit_preference": pref.get("implicit_preference", ""),
                        "created_at": cluster.created_at,
                        "user_id": user_id,
                        "size": cluster.size,
                        "preference_type": "implicit_preference"
                    }
                )
                implicit_memories.append(mem)

            self.vector_db.add("implicit_preference", implicit_memories)

        if topic_clusters:
            for cluster in topic_clusters:
                if cluster.cluster_id not in topic_cluster_prefs:
                    print(f"Warning: No preference found for topic cluster {cluster.cluster_id}, skipping...")
                    continue
                pref = topic_cluster_prefs[cluster.cluster_id]
                mem = VecDBItem(
                    id=cluster.cluster_id,
                    vector=cluster.center_vector,
                    payload={
                        "cluster_id": cluster.cluster_id,
                        "center_dialog_msgs": cluster.center_dialog_msgs,
                        "center_dialog_str": cluster.center_dialog_str,
                        "center_vector": cluster.center_vector,
                        "topic_cluster_name": pref.get("topic_cluster_name", ""),
                        "topic_cluster_description": pref.get("topic_cluster_description", ""),
                        "topic_preference": pref.get("topic_preference", ""),
                        "created_at": cluster.created_at,
                        "user_id": user_id,
                        "size": cluster.size,
                        "preference_type": "topic_preference"
                    }
                )
                topic_memories.append(mem)

            self.vector_db.add("topic_preference", topic_memories)

        if user_prefs:
            mem = VecDBItem(
                id=user_id,
                vector=[0.0] * self.vector_db.config.vector_dimension,
                payload={
                    "user_id": user_id,
                    "user_preference": user_prefs.get("user_preference", ""),
                    "created_at": datetime.now().isoformat(),
                    "preference_type": "user_preference"
                }
            )
            self.vector_db.add("user_preference", [mem])

    def _generate_memory_summary(self, explicit_infos: List[Dict[str, Any]],
                                 implicit_infos: List[Dict[str, Any]],
                                 topic_infos: List[Dict[str, Any]],
                                 user_infos: List[Dict[str, Any]]) -> str:
        """Generate a summary of the built memory."""
        summary = {
            "memory_build_summary": {
                "explicit_preferences_count": len(explicit_infos),
                "implicit_preferences_count": len(implicit_infos),
                "topic_preferences_count": len(topic_infos),
                "user_preferences_count": len(user_infos),
                "build_timestamp": datetime.now().isoformat()
            }
        }
        
        return json.dumps(summary, ensure_ascii=False, indent=2)
    
    def slow_update(self):
        """Retrieve all dialog info from the expicit preference collection, 
        and reconstruct the implicit preference collection, topic collection and user preference collection.
        """

        # refresh the implicit preference collection, topic collection and user preference collection
        self.vector_db.delete_collection("implicit_preference")
        self.vector_db.delete_collection("topic_preference")
        self.vector_db.delete_collection("user_preference")

        self.vector_db.create_collection_by_name("implicit_preference")
        self.vector_db.create_collection_by_name("topic_preference")
        self.vector_db.create_collection_by_name("user_preference")


        all_data = self.vector_db.get_all("explicit_preference")
        user_id = all_data[0].payload.get("user_id", "")
        informations = [item.payload for item in all_data]
        
        # Perform clustering
        implicit_clusters = self._implicit_cluster(informations)
        topic_clusters = self._topic_cluster(informations)

        # create extract inputs for each implicit and topic cluster
        implicit_extract_inputs = self._create_cluster_extract_input(implicit_clusters, informations, "original")
        topic_extract_inputs = self._create_cluster_extract_input(topic_clusters, informations, "original")
        
        # Extract preferences
        if implicit_extract_inputs:
            implicit_cluster_prefs = self._extract_implicit_preferences(implicit_extract_inputs)
        if topic_extract_inputs:
            topic_cluster_prefs = self._extract_topic_preferences(topic_extract_inputs)
        
            # Extract user preferences
            user_prefs = self._extract_user_preferences(topic_cluster_prefs)
        



        # Store all preferences in memory
        self._store_preferences(
            implicit_clusters=implicit_clusters,
            topic_clusters=topic_clusters,
            implicit_cluster_prefs=implicit_cluster_prefs,
            topic_cluster_prefs=topic_cluster_prefs,
            user_prefs=user_prefs,
            user_id=user_id,
        )
        
        # Return summary of built memory
        return self._generate_memory_summary(
            explicit_infos=informations,
            implicit_infos=implicit_clusters,
            topic_infos=topic_clusters,
            user_infos=user_prefs,
        )

        

