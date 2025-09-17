from abc import ABC, abstractmethod
from typing import Any, List, Dict
from datetime import datetime
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

    @abstractmethod
    def update(self, new_dialog: MessageList, *args, **kwargs) -> None:
        """Update the dialog.
        Args:
            new_dialog (MessageList): The new dialog to update.
            *args: Additional positional arguments.
            **kwargs: Additional keyword arguments.
        """


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
        return self.clusterer.cluster(vectors)
        
    def _topic_cluster(self, informations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Topic cluster."""
        vectors = [info.get("topic_vector") for info in informations]
        if not vectors:
            return []
        return self.clusterer.cluster(vectors)

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

    def _extract_implicit_preferences(self, implicit_extract_inputs: Dict[str, List[str]], max_workers: int = 10) -> List[Dict[str, Any]]:
        """Extract implicit preferences from implicit extract inputs using thread pool."""
        if not implicit_extract_inputs:
            return []
        
        results = []
        with ThreadPoolExecutor(max_workers=min(max_workers, len(implicit_extract_inputs))) as executor:
            future_to_cluster = {
                executor.submit(self._process_single_implicit_cluster, cluster_id, cluster_dialogs): cluster_id
                for cluster_id, cluster_dialogs in implicit_extract_inputs.items()
            }
            
            for future in as_completed(future_to_cluster):
                try:
                    result = future.result()
                    if result["implicit_exract_result"] is not None:
                        results.append(result)
                except Exception as e:
                    cluster_id = future_to_cluster[future]
                    print(f"Error processing implicit cluster {cluster_id}: {e}")
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

    def _extract_topic_preferences(self, topic_extract_inputs: Dict[str, List[str]], max_workers: int = 10) -> List[Dict[str, Any]]:
        """Extract topic preferences from topic extract inputs using thread pool."""
        if not topic_extract_inputs:
            return []
        
        results = []
        with ThreadPoolExecutor(max_workers=min(max_workers, len(topic_extract_inputs))) as executor:
            future_to_cluster = {
                executor.submit(self._process_single_topic_cluster, cluster_id, cluster_dialogs): cluster_id
                for cluster_id, cluster_dialogs in topic_extract_inputs.items()
            }
            
            for future in as_completed(future_to_cluster):
                try:
                    result = future.result()
                    if result["topic_exract_result"] is not None:
                        results.append(result)
                except Exception as e:
                    cluster_id = future_to_cluster[future]
                    print(f"Error processing topic cluster {cluster_id}: {e}")
                    continue
        
        return results

    def _store_preferences(self, 
                           implicit_prefs: List[Dict[str, Any]], 
                           topic_prefs: List[Dict[str, Any]],
                           user_prefs: List[Dict[str, Any]],
                           user_id: str):
        """Store all preferences in memory."""
        
        # Store implicit preferences
        if implicit_prefs:
            implicit_memories = []
            for pref in implicit_prefs:
                # Create VecDBItem directly using existing embedding
                vec_db_item = VecDBItem(
                    id=pref.get("cluster_id", ""),
                    vector=pref.get("center_vector", []),
                    payload={
                        "cluster_id": pref.get("cluster_id", ""),
                        "center_dialog": pref.get("center_dialog", ""),
                        "center_vector": pref.get("center_vector", []),
                        "implicit_preference": pref.get("implicit_preference", ""),
                        "created_at": pref.get("created_at", datetime.now().isoformat()),
                        "user_id": user_id,
                        "preference_type": "implicit_preference"
                    }
                )
                implicit_memories.append(vec_db_item)
            
            # Store in implicit_preference collection
            self.vector_db.add("implicit_preference", implicit_memories)
        
        # Store topic preferences
        if topic_prefs:
            topic_memories = []
            for pref in topic_prefs:
                # Create VecDBItem directly using existing embedding
                vec_db_item = VecDBItem(
                    id=pref.get("cluster_id", ""),
                    vector=pref.get("center_vector", []),
                    payload={
                        "cluster_id": pref.get("cluster_id", ""),
                        "center_dialog": pref.get("center_dialog", ""),
                        "center_vector": pref.get("center_vector", []),
                        "topic_cluster_name": pref.get("topic_cluster_name", ""),
                        "topic_cluster_description": pref.get("topic_cluster_description", ""),
                        "topic_preferences": pref.get("topic_preferences", ""),
                        "created_at": pref.get("created_at", datetime.now().isoformat()),
                        "user_id": user_id,
                        "preference_type": "topic_preference"
                    }
                )
                topic_memories.append(vec_db_item)
            
            # Store in topic_preference collection
            self.vector_db.add("topic_preference", topic_memories)
        
        # Store user preferences
        if user_prefs:
            user_memories = []
            for pref in user_prefs:
                # Create VecDBItem with zero vector (user preferences don't need vector search)
                # Use zero vector to satisfy Milvus collection dimension requirements
                # Get embedding dimension from embedder config
                embedding_dim = getattr(self.embedder.config, 'embedding_dims', 768)  # Default to 768 if not available
                zero_vector = [0.0] * embedding_dim
                vec_db_item = VecDBItem(
                    id=user_id,
                    vector=zero_vector,
                    payload={
                        "user_id": user_id,
                        "user_preferences": pref.get("user_preferences", ""),
                        "created_at": datetime.now().isoformat(),
                        "preference_type": "user_preference"
                    }
                )
                user_memories.append(vec_db_item)
            
            # Store in user_preference collection
            self.vector_db.add("user_preference", user_memories)
    
    def _generate_memory_summary(self, explicit_prefs: List[Dict[str, Any]], 
                                 implicit_prefs: List[Dict[str, Any]], 
                                 topic_prefs: List[Dict[str, Any]], 
                                 user_prefs: List[Dict[str, Any]]) -> str:
        """Generate a summary of the built memory."""
        summary = {
            "memory_build_summary": {
                "explicit_preferences_count": len(explicit_prefs),
                "implicit_preferences_count": len(implicit_prefs),
                "topic_preferences_count": len(topic_prefs),
                "user_preferences_count": len(user_prefs),
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
            implicit_cluster_info = self._extract_implicit_preferences(implicit_extract_inputs)
        if topic_extract_inputs:
            topic_cluster_info = self._extract_topic_preferences(topic_extract_inputs)
        
            # Extract user preferences
            user_preferences = self.extractor.extract_user_preferences(topic_cluster_info)
        



        # Store all preferences in memory
        self._store_preferences(
            explicit_prefs=informations,
            implicit_prefs=implicit_clusters,
            topic_prefs=topic_clusters,
            user_prefs=user_preferences,
            user_id=user_id,
        )
        
        # Return summary of built memory
        return self._generate_memory_summary(
            explicit_prefs=informations,
            implicit_prefs=implicit_clusters,
            topic_prefs=topic_clusters,
            user_prefs=user_preferences,
        )

        

