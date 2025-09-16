from memos.types import MessageList
from typing import List, Dict, Any, Optional
import uuid
import json
from datetime import datetime

from memos.templates.prefer_complete_prompt import (
    NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_TOPIC_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_USER_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_TOPIC_INFO_EXTRACT_PROMPT,
    NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT,
    NAIVE_PREFERENCE_INTEGRATION_PROMPT
)
from memos.memories.textual.prefer_text_memory.clustering import HDBSCANClusterer
from memos.vec_dbs.item import VecDBItem


class NaiveOp:
    """Naive operation."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive operation."""
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    def build_qa_pairs(self, chat_history: MessageList) -> List[MessageList]:
        """Build QA pairs from chat history."""
        qa_pairs = []
        current_qa_pair = []
        
        for message in chat_history:
            role = message["role"]
            
            if role == "user":
                # If we have a complete QA pair, save it
                if len(current_qa_pair) >= 2:  # At least question + answer
                    qa_pairs.append(current_qa_pair)
                
                # Start new QA pair
                current_qa_pair = [message]
                
            elif role == "assistant":
                # Add answer to current QA pair
                current_qa_pair.append(message)
        
        # Don't forget the last QA pair if it exists and is complete
        if len(current_qa_pair) >= 2:
            qa_pairs.append(current_qa_pair)
        
        return qa_pairs
    
    def extract_basic_info(self, qa_pair: MessageList) -> Dict[str, Any]:
        """Extract basic information from a QA pair (no LLM needed)."""
        basic_info = {
            "dialog_id": str(uuid.uuid4()),
            "dialog_msgs": qa_pair,
            "dialog_str": "\n".join([f"{msg['role']}: {msg['content']}" for msg in qa_pair]),
            "created_at": datetime.now().isoformat()
        }
        
        return basic_info

    def extract_topic_info(self, qa_pair: MessageList) -> Optional[Dict[str, Any]]:
        """Extract topic information from a QA pair."""
        # Convert qa_pair to string format
        qa_pair_str = "\n".join([f"{msg['role']}: {msg['content']}" for msg in qa_pair])
        prompt = NAIVE_TOPIC_INFO_EXTRACT_PROMPT.replace("{qa_pair}", qa_pair_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            return result
        except Exception:
            return response 
    
    def extract_explicit_preference(self, qa_pair: MessageList) -> Optional[Dict[str, Any]]:
        """Extract explicit preference from a QA pair (LLM-1)."""
        # Convert qa_pair to string format
        qa_pair_str = "\n".join([f"{msg['role']}: {msg['content']}" for msg in qa_pair])
        prompt = NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pair}", qa_pair_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            return result
        except Exception:
            return response
    
    def generate_dialogue_vectors(self, basic_infos: List[Dict[str, Any]]) -> List[List[float]]:
        """Generate embeddings for dialogue segments."""
        if not self.embedder or not basic_infos:
            return []
        
        texts = [info.get("dialog_str", "") for info in basic_infos]
        embdeddings = self.embedder.embed(texts)
        return [{"dialog_vector": embedding} for embedding in embdeddings]
    
    def generate_topic_vectors(self, topic_infos: List[Dict[str, Any]]) -> List[List[float]]:
        """Generate embeddings for topic information."""
        if not self.embedder:
            return []
        
        texts = [f"{info.get('topic_name', '')} {info.get('topic_description', '')}" for info in topic_infos]
        embdeddings = self.embedder.embed(texts)
        return [{"topic_vector": embedding} for embedding in embdeddings]

    def concat_infos(
        self, 
        basic_infos: List[Dict[str, Any]] = None, 
        explicit_preferences: List[Dict[str, Any]] = None, 
        topic_infos: List[Dict[str, Any]] = None, 
        dialogue_vectors: List[Dict[str, Any]] = None, 
        topic_vectors: List[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """Concatenate infos - only merge if not None."""
        # Get all non-None lists
        lists_to_zip = []
        for lst in [basic_infos, explicit_preferences, topic_infos, dialogue_vectors, topic_vectors]:
            if lst is not None:
                lists_to_zip.append(lst)
        
        if not lists_to_zip:
            return []
        
        # Use the first list to determine length
        length = len(lists_to_zip[0])
        
        whole_infos = []
        for i in range(length):
            merged_dict = {}
            
            # Only merge if not None
            if basic_infos is not None and i < len(basic_infos):
                merged_dict.update(basic_infos[i])
            if explicit_preferences is not None and i < len(explicit_preferences):
                merged_dict.update(explicit_preferences[i])
            if topic_infos is not None and i < len(topic_infos):
                merged_dict.update(topic_infos[i])
            if dialogue_vectors is not None and i < len(dialogue_vectors):
                merged_dict.update(dialogue_vectors[i])
            if topic_vectors is not None and i < len(topic_vectors):
                merged_dict.update(topic_vectors[i])
            
            whole_infos.append(merged_dict)
        
        return whole_infos

    def implicit_cluster(self, clusterer: HDBSCANClusterer, whole_infos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Implicit cluster."""
        # Extract vectors for clustering
        vectors = [info.get("dialog_vector") for info in whole_infos]
        if not vectors:
            return []
        # Perform clustering
        cluster_results = clusterer.cluster(vectors)
        
        # Map cluster results back to original data
        for cluster in cluster_results:
            cluster["center_dialog"] = whole_infos[cluster["center_index"]]["dialog_msgs"]
            cluster["center_dialog_str"] = whole_infos[cluster["center_index"]]["dialog_str"]
            original_infos = []
            for item in cluster["items"]:
                index = item["index"]
                original_info = whole_infos[index]
                original_infos.append({
                    "dialog_id": original_info.get("dialog_id"),
                    "dialog_msgs": original_info.get("dialog_msgs"),
                    "dialog_str": original_info.get("dialog_str"),
                    "created_at": original_info.get("created_at")
                })
            cluster["original_data"] = original_infos
        
        return cluster_results
    
    def topic_cluster(self, clusterer: HDBSCANClusterer, whole_infos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Topic cluster."""
        # Extract vectors for clustering
        vectors = [info.get("topic_vector") for info in whole_infos]
        if not vectors:
            return []
        # Perform clustering
        cluster_results = clusterer.cluster(vectors)
        
        # Map cluster results back to original data
        for cluster in cluster_results:
            cluster["center_dialog"] = whole_infos[cluster["center_index"]]["dialog_str"]
            original_infos = []
            for item in cluster["items"]:
                index = item["index"]
                original_info = whole_infos[index]
                original_infos.append({
                    "dialog_id": original_info.get("dialog_id"),
                    "dialog_msgs": original_info.get("dialog_msgs"),
                    "dialog_str": original_info.get("dialog_str"),
                    "created_at": original_info.get("created_at")
                })
            cluster["original_data"] = original_infos
        
        return cluster_results

    
    def extract_implicit_preferences(self, clusters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Extract implicit preferences from clusters."""
        if not clusters:
            return []
        for cluster in clusters:
            # Get dialogue segments in this cluster
            qa_pairs = "\n".join([info["dialog_str"] for info in cluster["original_data"]])
            
            prompt = NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pairs}", qa_pairs)
            
            try:
                response = self.llm_provider.generate([{"role": "user", "content": prompt}])
                result = json.loads(response)
                
                if result.get("implicit_preference"):
                    cluster["implicit_preference"] = result
            except Exception as e:
                print(e)
                cluster["implicit_preference"] = ""

        return clusters
    
    def extract_topic_preferences(self, clusters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Extract topic preferences from clusters."""
        if not clusters:
            return []
        for cluster in clusters:
            # Get dialogue segments in this cluster
            qa_pairs = "\n".join([info["dialog_str"] for info in cluster["original_data"]])
            
            prompt = NAIVE_TOPIC_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pairs}", qa_pairs)
            
            try:
                response = self.llm_provider.generate([{"role": "user", "content": prompt}])
                result = json.loads(response)

                cluster["topic_cluster_name"] = result.get("topic_cluster_name", "")
                cluster["topic_cluster_description"] = result.get("topic_cluster_description", "")
                cluster["topic_preferences"] = result.get("topic_preferences", "")
            except Exception as e:
                print(e)
                cluster["topic_cluster_name"] = ""
                cluster["topic_cluster_description"] = ""
                cluster["topic_preferences"] = ""
        
        return clusters
    
    def extract_user_preferences(self, topic_preferences: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Extract user-level preferences."""
        if not topic_preferences:
            return []
        cluster_infos = [{
            "topic_cluster_name": cluster["topic_cluster_name"], 
            "topic_cluster_description": cluster["topic_cluster_description"], 
            "topic_preferences": cluster["topic_preferences"]} 
            for cluster in topic_preferences]
        prompt = NAIVE_USER_PREFERENCE_EXTRACT_PROMPT.replace("{cluster_info}", json.dumps(cluster_infos, ensure_ascii=False, indent=2))
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            
            if result.get("user_preferences"):
                return result
        except Exception as e:
            print(e)
            return ""
    
    def judge_update_or_add(self, old_msg: MessageList, new_msg: MessageList) -> bool:
        """Judge if the new message expresses the same core content as the old message."""
        # Convert messages to string format for comparison
        old_str = "\n".join([f"{msg['role']}: {msg['content']}" for msg in old_msg])
        new_str = "\n".join([f"{msg['role']}: {msg['content']}" for msg in new_msg])
        
        # Use the template prompt with placeholders
        prompt = NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT.replace("{old_information}", old_str).replace("{new_information}", new_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            response = result.get("is_same", False)
            return response if isinstance(response, bool) else response == "true"
        except Exception as e:
            print(f"Error in judge_update_or_add: {e}")
            # Fallback to simple string comparison
            return old_str == new_str

    def preference_integration(self, query: str, 
                                explicit_prefs: List[Dict[str, Any]], 
                               implicit_prefs: List[Dict[str, Any]],
                               topic_prefs: List[Dict[str, Any]],
                               user_prefs: List[Dict[str, Any]]) -> str:
        """Integrate preferences."""
        explicit_prefs_str = json.dumps(explicit_prefs, ensure_ascii=False, indent=2)
        implicit_prefs_str = json.dumps(implicit_prefs, ensure_ascii=False, indent=2)
        topic_prefs_str = json.dumps(topic_prefs, ensure_ascii=False, indent=2)
        user_prefs_str = json.dumps(user_prefs, ensure_ascii=False, indent=2)

        prompt = NAIVE_PREFERENCE_INTEGRATION_PROMPT.format(
            query_preference=query,
            explicit_preference=explicit_prefs_str,
            implicit_preference=implicit_prefs_str,
            topic_preference=topic_prefs_str,
            user_preference=user_prefs_str
        )
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            return result["final_prompt"]
        except Exception as e:
            print(f"Error in preference_integration: {e}")
            return ""

        
    def store_preferences(self, explicit_prefs: List[Dict[str, Any]], 
                           implicit_prefs: List[Dict[str, Any]], 
                           topic_prefs: List[Dict[str, Any]],
                           user_prefs: List[Dict[str, Any]],
                           user_id: str):
        """Store all preferences in memory."""
        
        # Convert to VecDBItem format and store in separate collections
        
        # Store explicit preferences
        if explicit_prefs:
            explicit_memories = []
            for pref in explicit_prefs:
                # Create VecDBItem directly using existing embedding
                vec_db_item = VecDBItem(
                    id=pref.get("dialog_id", ""),
                    vector=pref.get("dialog_vector", []),
                    payload={
                        "dialog_id": pref.get("dialog_id", ""),
                        "dialog_msgs": pref.get("dialog_msgs", []),
                        "dialog_str": pref.get("dialog_str", ""),
                        "dialog_vector": pref.get("dialog_vector", []),
                        "created_at": pref.get("created_at", datetime.now().isoformat()),
                        "topic_name": pref.get("topic_name", ""),
                        "topic_description": pref.get("topic_description", ""),
                        "topic_vector": pref.get("topic_vector", []),
                        "user_id": user_id,
                        "preference_type": "explicit_preference"
                    }
                )
                explicit_memories.append(vec_db_item)
            
            # Store in explicit_preference collection
            self.vector_db.add("explicit_preference", explicit_memories)
        
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
    
    def generate_memory_summary(self, explicit_prefs: List[Dict[str, Any]], 
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
