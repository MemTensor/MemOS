from abc import ABC, abstractmethod
from typing import Optional, Dict, List, Any, Tuple
import uuid
import json
from datetime import datetime

from memos.llms.base import BaseLLM
from memos.memories.textual.prefer_text_memory import naive_op
from memos.types import ChatHistory, MessageList
from memos.embedders.base import BaseEmbedder
from memos.vec_dbs.base import BaseVecDB
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.vec_dbs.item import VecDBItem

from memos.memories.textual.prefer_text_memory.clustering import HDBSCANClusterer
from memos.memories.textual.prefer_text_memory.naive_op import NaiveOp



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
        
        # Initialize clustering manager
        clusterer = HDBSCANClusterer()
        naive_op = NaiveOp(self.llm_provider, self.embedder, self.vector_db)
        
        # Step 1: Build QA pairs from chat history
        qa_pairs = naive_op.build_qa_pairs(history.chat_history)
        
        # Step 2: Process each QA pair
        basic_infos = []
        explicit_preferences = []
        topic_infos = []
        
        for qa_pair in qa_pairs:
            # Extract basic info
            basic_info = naive_op.extract_basic_info(qa_pair)
            basic_infos.append(basic_info)

            # Extract topic information
            topic_info = naive_op.extract_topic_info(qa_pair)
            if topic_info:
                topic_infos.append(topic_info)
            
            # Extract explicit preference from
            explicit_pref = naive_op.extract_explicit_preference(qa_pair)
            if explicit_pref:
                explicit_preferences.append(explicit_pref)
        
        # Step 3: Generate embeddings
        dialogue_vectors = naive_op.generate_dialogue_vectors(basic_infos)
        topic_vectors = naive_op.generate_topic_vectors(topic_infos)

        whole_infos = naive_op.concat_infos(basic_infos, explicit_preferences, topic_infos, dialogue_vectors, topic_vectors)
        
        # Step 4: Perform clustering
        implicit_clusters = naive_op.implicit_cluster(clusterer, whole_infos)
        topic_clusters = naive_op.topic_cluster(clusterer, whole_infos)
        
        # Step 5: Extract implicit preferences
        implicit_clusters = naive_op.extract_implicit_preferences(implicit_clusters)
        
        # Step 6: Extract topic preferences
        topic_clusters = naive_op.extract_topic_preferences(topic_clusters)
        
        # Step 7: Extract user preferences
        user_preferences = naive_op.extract_user_preferences(topic_clusters)
        
        # Step 8: Store all preferences in memory
        naive_op.store_preferences(
            explicit_prefs=whole_infos,
            implicit_prefs=implicit_clusters,
            topic_prefs=topic_clusters,
            user_prefs=user_preferences,
            user_id=history.user_id,
        )
        
        # Step 9: Return summary of built memory
        return naive_op.generate_memory_summary(
            explicit_prefs=whole_infos,
            implicit_prefs=implicit_clusters,
            topic_prefs=topic_clusters,
            user_prefs=user_preferences,
        )
    