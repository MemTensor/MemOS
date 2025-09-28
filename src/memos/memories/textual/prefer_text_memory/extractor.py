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
        qa_pair_str = convert_messages_to_string(qa_pair) if isinstance(qa_pair, list) else qa_pair
        prompt = NAIVE_TOPIC_INFO_EXTRACT_PROMPT.replace("{qa_pair}", qa_pair_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            return result
        except Exception as e:
            print(f"Error extracting topic info: {e}, return None")
            return None 
    
    def extract_explicit_preference(self, qa_pair: MessageList | str) -> Dict[str, Any] | None:
        """Extract explicit preference from a QA pair."""
        qa_pair_str = convert_messages_to_string(qa_pair) if isinstance(qa_pair, list) else qa_pair
        prompt = NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pair}", qa_pair_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            return result
        except Exception as e:
            print(f"Error extracting explicit preference: {e}, return None")
            return None

    def extract_implicit_preferences(self, qa_pairs: MessageList | list[str]) -> Dict[str, Any] | None:
        """Extract implicit preferences from cluster qa pairs."""
        if not qa_pairs:
            return None
        qa_pairs_str = convert_messages_to_string(qa_pairs) if isinstance(qa_pairs[0], dict) else "\n\n".join(qa_pairs)
        prompt = NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pairs}", qa_pairs_str)
            
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            return result
        except Exception as e:
            print(f"Error extracting implicit preferences: {e}, return None")
            return None
    
    def extract_topic_preferences(self, qa_pairs: MessageList | list[str]) -> Dict[str, Any] | None:
        """Extract topic preferences from cluster qa pairs."""
        if not qa_pairs:
            return None
        qa_pairs_str = convert_messages_to_string(qa_pairs) if isinstance(qa_pairs[0], dict) else "\n\n".join(qa_pairs)
        prompt = NAIVE_TOPIC_PREFERENCE_EXTRACT_PROMPT.replace("{qa_pairs}", qa_pairs_str)
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            
            if result.get("topic_cluster_name"):
                return result
        except Exception as e:
            print(f"Error extracting topic preferences: {qa_pairs}\n{e}, return None")
            return None
    
    def extract_user_preferences(self, topic_preferences: List[Dict[str, Any]]) -> Dict[str, Any] | None:
        """Extract user-level preferences."""
        if not topic_preferences:
            return []

        prompt = NAIVE_USER_PREFERENCE_EXTRACT_PROMPT.replace("{cluster_info}", json.dumps(topic_preferences, ensure_ascii=False, indent=2))
        
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            if result.get("user_preference"):
                return result
        except Exception as e:
            print(f"Error processing user preferences: {topic_preferences}\n{e}, return None")
            return ""

    def _process_single_chunk_explicit(self, chunk: MessageList, msg_type: str, info: dict[str, Any]) -> TextualMemoryItem | None:
        """Process a single chunk and return a TextualMemoryItem."""
        basic_info = self.extract_basic_info(chunk)
        topic_info = self.extract_topic_info(chunk)
        explicit_pref = self.extract_explicit_preference(chunk)
        if not explicit_pref:
            return None

        vector_info = {
            "dialog_vector": self.embedder.embed([basic_info["dialog_str"]])[0],
            "topic_vector": self.embedder.embed([topic_info["topic_name"] + topic_info["topic_description"]])[0]
        }
        extract_info = {**basic_info, **topic_info, **explicit_pref, **vector_info, **info}

        metadata = PreferenceTextualMemoryMetadata(type=msg_type, preference_type="explicit_preference", **extract_info)
        memory = TextualMemoryItem(id=extract_info["dialog_id"], memory=extract_info["dialog_str"], metadata=metadata)
        return memory

    def _process_single_chunk_implicit(self, chunk: MessageList, msg_type: str, info: dict[str, Any]) -> TextualMemoryItem | None:
        basic_info = self.extract_basic_info(chunk)
        implicit_pref = self.extract_implicit_preferences(chunk)
        if not implicit_pref:
            return None
        
        vector_info = {
            "dialog_vector": self.embedder.embed([basic_info["dialog_str"]])[0],
        }

        extract_info = {**basic_info, **implicit_pref, **vector_info, **info}

        metadata = PreferenceTextualMemoryMetadata(type=msg_type, preference_type="implicit_preference", **extract_info)
        memory = TextualMemoryItem(id=extract_info["dialog_id"], memory=extract_info["dialog_str"], metadata=metadata)
        return memory

    def extract(self, messages: list[MessageList], msg_type: str, info: dict[str, Any], max_workers: int = 10) -> list[TextualMemoryItem]:
        """Extract preference memories based on the messages using thread pool for acceleration."""
        chunks_for_explicit: list[MessageList] = []
        for message in messages:
            chunk = self.splitter.split_chunks(message, split_type="lookback")
            chunks_for_explicit.extend(chunk)
        if not chunks_for_explicit:
            return []

        chunks_for_implicit: list[MessageList] = []
        for message in messages:
            chunk = self.splitter.split_chunks(message, split_type="overlap")
            chunks_for_implicit.extend(chunk)

        memories = []
        with ThreadPoolExecutor(max_workers=min(max_workers, len(chunks_for_explicit) + len(chunks_for_implicit))) as executor:
            futures = {
                executor.submit(self._process_single_chunk_explicit, chunk, msg_type, info): ("explicit", chunk)
                for chunk in chunks_for_explicit
            }
            futures.update({
                executor.submit(self._process_single_chunk_implicit, chunk, msg_type, info): ("implicit", chunk)
                for chunk in chunks_for_implicit
            })
            
            for future in as_completed(futures):
                try:
                    memory = future.result()
                    if memory:
                        memories.append(memory)
                except Exception as e:
                    task_type, chunk = futures[future]
                    print(f"Error processing {task_type} chunk: {chunk}\n{e}")
                    continue

        return memories