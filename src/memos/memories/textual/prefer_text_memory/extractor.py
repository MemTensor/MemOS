import json
import uuid
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, Optional, List
from concurrent.futures import ThreadPoolExecutor, as_completed
from memos.types import MessageList
from memos.memories.textual.item import TextualMemoryItem, PreferenceTextualMemoryMetadata
from memos.templates.prefer_complete_prompt import (
    NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_TOPIC_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_USER_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_TOPIC_INFO_EXTRACT_PROMPT,
)
from memos.memories.textual.prefer_text_memory.spliter import Splitter
from memos.memories.textual.prefer_text_memory.utils import convert_messages_to_string

class BaseExtractor(ABC):
    """Abstract base class for extractors."""
    
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the extractor."""


class NaiveExtractor(BaseExtractor):
    """Extractor."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the extractor."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db
        self.splitter = Splitter()

    def extract_basic_info(self, qa_pair: MessageList) -> Dict[str, Any]:
        """Extract basic information from a QA pair (no LLM needed)."""
        basic_info = {
            "dialog_id": str(uuid.uuid4()),
            "dialog_msgs": qa_pair,
            "dialog_str": convert_messages_to_string(qa_pair),
            "created_at": datetime.now().isoformat()
        }
        
        return basic_info

    def extract_topic_info(self, qa_pair: MessageList | str) -> Dict[str, Any]:
        """Extract topic information from a QA pair."""
        qa_pair_str = convert_messages_to_string(qa_pair) if isinstance(qa_pair, MessageList) else qa_pair
        prompt = NAIVE_TOPIC_INFO_EXTRACT_PROMPT.replace("{qa_pair}", qa_pair_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            return result
        except Exception:
            return response 
    
    def extract_explicit_preference(self, qa_pair: MessageList | str) -> Dict[str, Any]:
        """Extract explicit preference from a QA pair."""
        qa_pair_str = convert_messages_to_string(qa_pair) if isinstance(qa_pair, MessageList) else qa_pair
        prompt = NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pair}", qa_pair_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            return result
        except Exception:
            return response

    def extract_implicit_preferences(self, qa_pairs: list[MessageList] | list[str]) -> List[Dict[str, Any]]:
        """Extract implicit preferences from cluster qa pairs."""
        qa_pairs_str = convert_messages_to_string(qa_pairs) if isinstance(qa_pairs, MessageList) else "\n\n".join(qa_pairs)
        prompt = NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pairs}", qa_pairs_str)
            
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            
            if result.get("implicit_preference"):
                return result
        except Exception as e:
            print(f"Error processing cluster: {qa_pairs}\n{e}")
            return ""
    
    def extract_topic_preferences(self, qa_pairs: list[MessageList] | list[str]) -> List[Dict[str, Any]]:
        """Extract topic preferences from cluster qa pairs."""
        qa_pairs_str = convert_messages_to_string(qa_pairs) if isinstance(qa_pairs, MessageList) else "\n\n".join(qa_pairs)
        prompt = NAIVE_TOPIC_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pairs}", qa_pairs_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            
            if result.get("topic_cluster_name"):
                return result
        except Exception as e:
            print(f"Error processing cluster: {qa_pairs}\n{e}")
            return ""
    
    def extract_user_preferences(self, topic_preferences: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Extract user-level preferences."""
        if not topic_preferences:
            return []

        prompt = NAIVE_USER_PREFERENCE_EXTRACT_PROMPT.replace("{cluster_info}", json.dumps(topic_preferences, ensure_ascii=False, indent=2))
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            result = json.loads(response)
            
            if result.get("user_preference"):
                return result
        except Exception as e:
            print(f"Error processing user preferences: {topic_preferences}\n{e}")
            return ""

    def concat_infos(
        self, 
        basic_infos: List[Dict[str, Any]] = None, 
        explicit_preferences: List[Dict[str, Any]] = None, 
        topic_infos: List[Dict[str, Any]] = None, 
        dialogue_vectors: List[Dict[str, Any]] = None, 
        topic_vectors: List[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """Concatenate infos - only merge if not None."""
        # Get all non-None lists
        list_to_concat = []
        for lst in [basic_infos, explicit_preferences, topic_infos, dialogue_vectors, topic_vectors]:
            if lst is not None:
                list_to_concat.append(lst)
        
        if not list_to_concat:
            return []
        
        # Use the first list to determine length
        length = len(list_to_concat[0])
        
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

    def _process_single_chunk(self, chunk: MessageList, msg_type: str, info: dict[str, Any]) -> TextualMemoryItem:
        """Process a single chunk and return a TextualMemoryItem."""
        basic_info = self.extract_basic_info(chunk)
        topic_info = self.extract_topic_info(chunk)
        explicit_pref = self.extract_explicit_preference(chunk)

        vector_info = {
            "dialog_vector": self.embedder.embed([basic_info["dialog_str"]])[0],
            "topic_vector": self.embedder.embed([topic_info["topic_name"] + topic_info["topic_description"]])[0]
        }
        extract_info = {**basic_info, **topic_info, **explicit_pref, **vector_info, **info}

        metadata = PreferenceTextualMemoryMetadata(type=msg_type, preference_type="explicit_preference", **extract_info)
        memory = TextualMemoryItem(id=extract_info["dialog_id"], memory=extract_info["dialog_str"], metadata=metadata)
        return memory

    def extract(self, messages: MessageList, msg_type: str, info: dict[str, Any], max_workers: int = 10) -> list[TextualMemoryItem]:
        """Extract preference memories based on the messages using thread pool for acceleration."""
        chunks = self.splitter.split_chunks(messages)
        if not chunks:
            return []

        memories = []
        with ThreadPoolExecutor(max_workers=min(max_workers, len(chunks))) as executor:
            future_to_chunk = {
                executor.submit(self._process_single_chunk, chunk, msg_type, info): chunk 
                for chunk in chunks
            }
            
            for future in as_completed(future_to_chunk):
                try:
                    memory = future.result()
                    memories.append(memory)
                except Exception as e:
                    chunk = future_to_chunk[future]
                    print(f"Error processing chunk: {chunk}\n{e}")
                    continue

        return memories