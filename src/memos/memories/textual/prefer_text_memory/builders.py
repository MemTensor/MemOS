from abc import ABC, abstractmethod
from typing import Optional, Dict, List, Any, Tuple
import uuid
import json
from datetime import datetime

from memos.llms.base import BaseLLM
from memos.types import ChatHistory, MessageList
from memos.embedders.base import BaseEmbedder
from memos.vec_dbs.base import BaseVecDB
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.templates.prefer_complete_prompt import (
    NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_TOPIC_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_USER_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_TOPIC_INFO_EXTRACT_PROMPT
)
from memos.memories.textual.prefer_text_memory.clustering import HDBSCANClusterer
from memos.memories.textual.prefer_text_memory.chunk_merging import ChunkMergingManager, NaiveChunkMerger


class BaseBuilder(ABC):
    """
    Abstract base class for memory builders.
    
    Each builder implements a specific build strategy for creating
    preference memory content from chat history.
    """
    
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """
        Initialize the memory builder.
        
        Args:
            llm_provider: LLM provider for script generation (required for some strategies)
            embedder: Embedder for vector operations
            vector_db: Vector database for storage
        """
    
    @abstractmethod
    def build(self, history: ChatHistory) -> str:
        """
        Build memory content from chat history.
        
        Args:
            history: The chat history to build memory from.
            
        Returns:
            Memory content string formatted according to the build strategy
            
        Raises:
            RuntimeError: If memory building fails
        """



class NaiveBuilder(BaseBuilder):
    """Naive memory builder."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive memory builder."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    

    def build(self, history: ChatHistory) -> str:
        """Build memory content from chat history following the preference extraction pipeline."""
        
        # Initialize clustering and chunk merging managers
        clusterer = HDBSCANClusterer()
        chunk_merging_manager = ChunkMergingManager(NaiveChunkMerger())
        
        # Step 1: Build QA pairs from chat history
        qa_pairs = self._build_qa_pairs(history.chat_history)
        
        # Step 2: Process each QA pair
        basic_infos = []
        explicit_preferences = []
        topic_infos = []
        
        for qa_pair in qa_pairs:
            # Extract basic info
            basic_info = self._extract_basic_info(qa_pair)
            basic_infos.append(basic_info)

            # Extract topic information
            topic_info = self._extract_topic_info(qa_pair)
            if topic_info:
                topic_infos.append(topic_info)
            
            # Extract explicit preference from
            explicit_pref = self._extract_explicit_preference(qa_pair)
            if explicit_pref:
                explicit_preferences.append(explicit_pref)
        
        # Step 3: Generate embeddings
        dialogue_vectors = self._generate_dialogue_vectors(basic_infos)
        topic_vectors = self._generate_topic_vectors(topic_infos)

        whole_infos = self._concat_infos(basic_infos, explicit_preferences, topic_infos, dialogue_vectors, topic_vectors)
        
        # Step 4: Perform clustering
        implicit_clusters = self._implicit_cluster(clusterer, whole_infos)
        topic_clusters = self._topic_cluster(clusterer, whole_infos)
        
        # Step 5: Extract implicit preferences
        implicit_preferences = self._extract_implicit_preferences(implicit_clusters)
        
        # Step 6: Extract topic preferences
        topic_preferences = self._extract_topic_preferences(topic_clusters)
        
        # Step 7: Handle chunk merging for long chunks (optional)
        merged_preferences = self._handle_chunk_merging(
            explicit_preferences, implicit_preferences, topic_preferences, chunk_merging_manager
        )
        
        # Step 8: Extract user preferences
        user_preferences = self._extract_user_preferences(topic_preferences)
        
        # Step 9: Store all preferences in memory
        self._store_preferences(
            explicit_preferences,
            implicit_preferences,
            topic_preferences,
            user_preferences,
            history.user_id
        )
        
        # Return summary of built memory
        return self._generate_memory_summary(
            explicit_preferences,
            implicit_preferences,
            topic_preferences,
            basic_infos,
            user_preferences
        )
    
    def _build_qa_pairs(self, chat_history: MessageList) -> List[MessageList]:
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
    
    def _extract_basic_info(self, qa_pair: MessageList) -> Dict[str, Any]:
        """Extract basic information from a QA pair (no LLM needed)."""
        basic_info = {
            "dialog_id": str(uuid.uuid4()),
            "dialog_msgs": qa_pair,
            "dialog_str": "\n".join([f"{msg['role']}: {msg['content']}" for msg in qa_pair]),
            "created_at": datetime.now().isoformat()
        }
        
        return basic_info

    def _extract_topic_info(self, qa_pair: MessageList) -> Optional[Dict[str, Any]]:
        """Extract topic information from a QA pair."""
        prompt = NAIVE_TOPIC_INFO_EXTRACT_PROMPT.replace("{qa_pair}", qa_pair)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            return result
        except Exception:
            return response 
    
    def _extract_explicit_preference(self, qa_pair: MessageList) -> Optional[Dict[str, Any]]:
        """Extract explicit preference from a QA pair (LLM-1)."""
        
        prompt = NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pair}", qa_pair)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            return result
        except Exception:
            return response
    
    def _generate_dialogue_vectors(self, basic_infos: List[Dict[str, Any]]) -> List[List[float]]:
        """Generate embeddings for dialogue segments."""
        if not self.embedder or not basic_infos:
            return []
        
        texts = [info.get("dialog_segment_str", "") for info in basic_infos]
        return self.embedder.embed(texts)
    
    def _generate_topic_vectors(self, topic_infos: List[Dict[str, Any]]) -> List[List[float]]:
        """Generate embeddings for topic information."""
        if not self.embedder:
            return []
        
        texts = [f"{info.get('topic_name', '')} {info.get('topic_description', '')}" for info in topic_infos]
        return self.embedder.embed(texts)

    def _concat_infos(
        self, 
        basic_infos: List[Dict[str, Any]], 
        explicit_preferences: List[Dict[str, Any]], 
        topic_infos: List[Dict[str, Any]], 
        dialogue_vectors: List[List[float]], 
        topic_vectors: List[List[float]]) -> List[Dict[str, Any]]:
        """Concatenate infos."""
        whole_infos = [{**bsc, **ep, **ti, "dialog_vector": dv, "topic_vector": tv} 
        for bsc, ep, ti, dv, tv in zip(basic_infos, explicit_preferences, topic_infos, dialogue_vectors, topic_vectors)]
        return whole_infos

    def _implicit_cluster(self, clusterer: HDBSCANClusterer, whole_infos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Implicit cluster."""
        # Extract vectors for clustering
        vectors = [info.get("dialog_vector") for info in whole_infos]
        
        # Perform clustering
        cluster_results = clusterer.cluster(vectors)
        
        # Map cluster results back to original data
        for cluster in cluster_results:
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
    
    def _topic_cluster(self, clusterer: HDBSCANClusterer, whole_infos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Topic cluster."""
        # Extract vectors for clustering
        vectors = [info.get("topic_vector") for info in whole_infos]
        
        # Perform clustering
        cluster_results = clusterer.cluster(vectors)
        
        # Map cluster results back to original data
        for cluster in cluster_results:
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

    
    def _handle_chunk_merging(self, explicit_prefs: List[Dict[str, Any]], 
                             implicit_prefs: List[Dict[str, Any]], 
                             topic_prefs: List[Dict[str, Any]], 
                             chunk_merging_manager) -> Dict[str, Any]:
        """Handle chunk merging for long chunks (optional step)."""
        merged_results = {
            "explicit_preferences": explicit_prefs,
            "implicit_preferences": implicit_prefs,
            "topic_preferences": topic_prefs,
            "merged_chunks": []
        }
        
        # Check for long chunks that need merging
        all_preferences = explicit_prefs + implicit_prefs + topic_prefs
        
        for pref in all_preferences:
            content = pref.get("preference", "")
            if len(content) > 4096:  # Long chunk threshold
                # Split the long chunk
                chunks = chunk_merging_manager.process_long_chunks([{
                    "content": content,
                    "id": pref.get("id", ""),
                    "preference": pref
                }])
                
                if len(chunks) > 1:
                    # Extract preferences from split chunks
                    chunk_preferences = [chunk.get("preference", {}) for chunk in chunks]
                    
                    # Merge preferences using LLM
                    merged_pref = chunk_merging_manager.merge_chunk_items(
                        chunk_preferences, self.llm_provider
                    )
                    
                    if merged_pref:
                        merged_results["merged_chunks"].append({
                            "original_preference": pref,
                            "merged_preference": merged_pref,
                            "chunk_count": len(chunks)
                        })
        
        return merged_results
    
    def _extract_implicit_preferences(self, clusters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Extract implicit preferences from clusters."""
        
        implicit_preferences = []
        
        for cluster in clusters:
            # Get dialogue segments in this cluster
            qa_pairs = "\n".join([info["dialog_str"] for info in cluster["original_data"]])
            
            prompt = NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pairs}", qa_pairs)
            
            try:
                response = self.llm_provider.generate([{"role": "user", "content": prompt}])
                result = json.loads(response)
                
                if result.get("implicit_preference"):
                    result["id"] = str(uuid.uuid4())
                    result["created_at"] = datetime.now().isoformat()
                    implicit_preferences.append(result)
            except Exception:
                continue
        
        return implicit_preferences
    
    def _extract_topic_preferences(self, clusters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Extract topic preferences from clusters."""
        
        topic_preferences = []
        
        for cluster in clusters:
            # Get topic infos in this cluster
            cluster_topics = [cluster["items"][i] for i in range(len(cluster["items"])) 
                            if i < len(cluster["items"])]
            
            prompt = f"""
            {NAIVE_TOPIC_PREFERENCE_EXTRACT_PROMPT}
            
            主题聚类信息:
            - 聚类ID: {cluster.get('cluster_id', '')}
            - 聚类大小: {cluster.get('size', 0)}
            
            相关主题信息:
            {json.dumps(cluster_topics, ensure_ascii=False, indent=2)}
            
            请提取主题偏好，返回JSON格式：
            {{
                "topic_preference": "主题偏好描述",
                "confidence": 0.8,
                "cluster_id": "{cluster.get('cluster_id', '')}"
            }}
            """
            
            try:
                response = self.llm_provider.generate([{"role": "user", "content": prompt}])
                result = json.loads(response)
                
                if result.get("topic_preference"):
                    result["id"] = str(uuid.uuid4())
                    result["created_at"] = datetime.now().isoformat()
                    topic_preferences.append(result)
            except Exception:
                continue
        
        return topic_preferences
    
    def _extract_user_preferences(self, topic_preferences: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Extract user-level preferences."""
        
        prompt = f"""
        {NAIVE_USER_PREFERENCE_EXTRACT_PROMPT}
        
        主题偏好信息:
        {json.dumps(topic_preferences, ensure_ascii=False, indent=2)}

        相关对话片段:
        {json.dumps(topic_preferences, ensure_ascii=False, indent=2)}
        
        请提取用户偏好，返回JSON格式：
        {{
            "user_preference": "用户偏好描述",
            "confidence": 0.8
        }}
        """
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            
            if result.get("user_preference"):
                result["id"] = str(uuid.uuid4())
                result["created_at"] = datetime.now().isoformat()
                return [result]
        except Exception:
            pass
        
        return []
    
    def _store_preferences(self, explicit_prefs: List[Dict[str, Any]], 
                           implicit_prefs: List[Dict[str, Any]], 
                           topic_prefs: List[Dict[str, Any]],
                           user_prefs: List[Dict[str, Any]], 
                           user_id: str):
        """Store all preferences in memory."""
        
        # Convert to TextualMemoryItem and store
        all_memories = []
        
        # Store explicit preferences
        for pref in explicit_prefs:
            memory_item = TextualMemoryItem(
                memory=pref.get("preference", ""),
                metadata=TextualMemoryMetadata(
                    user_id=user_id,
                    type="explicit_preference",
                    confidence=pref.get("confidence", 0.5),
                    source="conversation",
                    tags=["explicit", "preference"],
                    updated_at=pref.get("created_at", datetime.now().isoformat())
                )
            )
            all_memories.append(memory_item)
        
        # Store implicit preferences
        for pref in implicit_prefs:
            memory_item = TextualMemoryItem(
                memory=pref.get("implicit_preference", ""),
                metadata=TextualMemoryMetadata(
                    user_id=user_id,
                    type="implicit_preference",
                    confidence=pref.get("confidence", 0.5),
                    source="conversation",
                    tags=["implicit", "preference", pref.get("cluster_id", "")],
                    updated_at=pref.get("created_at", datetime.now().isoformat())
                )
            )
            all_memories.append(memory_item)
        
        # Store topic preferences
        for pref in topic_prefs:
            memory_item = TextualMemoryItem(
                memory=pref.get("topic_preference", ""),
                metadata=TextualMemoryMetadata(
                    user_id=user_id,
                    type="topic_preference",
                    confidence=pref.get("confidence", 0.5),
                    source="conversation",
                    tags=["topic", "preference", pref.get("cluster_id", "")],
                    updated_at=pref.get("created_at", datetime.now().isoformat())
                )
            )
            all_memories.append(memory_item)
        
        # Store user preferences
        for pref in user_prefs:
            memory_item = TextualMemoryItem(
                memory=pref.get("user_preference", ""),
                metadata=TextualMemoryMetadata(
                    user_id=user_id,
                    type="user_preference",
                    confidence=pref.get("confidence", 0.5),
                    source="conversation",
                    tags=["user", "preference"],
                    updated_at=pref.get("created_at", datetime.now().isoformat())
                )
            )
            all_memories.append(memory_item)
        
        # Store in vector database
        if all_memories:
            self.vector_db.add(all_memories)
    
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
                "total_memories": len(explicit_prefs) + len(implicit_prefs) + len(topic_prefs) + len(user_prefs),
                "build_timestamp": datetime.now().isoformat()
            }
        }
        
        return json.dumps(summary, ensure_ascii=False, indent=2)
