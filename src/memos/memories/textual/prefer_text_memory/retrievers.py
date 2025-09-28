from abc import ABC, abstractmethod
from typing import Any, Dict
from concurrent.futures import ThreadPoolExecutor, as_completed
from memos.memories.textual.item import TextualMemoryItem, PreferenceTextualMemoryMetadata


class BaseRetriever(ABC):
    """Abstract base class for retrievers."""
    
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the retriever."""


    @abstractmethod
    def retrieve(self, query: str, top_k: int, info: dict[str, Any]=None) -> list[TextualMemoryItem]:
        """Retrieve memories from the retriever."""

class NaiveRetriever(BaseRetriever):
    """Naive retriever."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive retriever."""
        super().__init__(llm_provider, embedder, vector_db)
        self.vector_db = vector_db
        self.embedder = embedder

    def retrieve(self, query: str, top_k: int, info: dict[str, Any]=None) -> list[TextualMemoryItem]:
        """Retrieve memories from the naive retriever."""
        # TODO: un-support rewrite query and session filter now
        if info:
            info = info.copy()  # Create a copy to avoid modifying the original
            info.pop("chat_history", None)
            info.pop("session_id", None)
        query_embeddings = self.embedder.embed([query])  # Pass as list to get list of embeddings
        query_embedding = query_embeddings[0]  # Get the first (and only) embedding
        
        # Use thread pool to parallelize the searches
        with ThreadPoolExecutor(max_workers=2) as executor:
            # Submit all search tasks
            future_explicit = executor.submit(self.vector_db.search, query_embedding, "explicit_preference", top_k, info)
            future_implicit = executor.submit(self.vector_db.search, query_embedding, "implicit_preference", top_k, info)
            future_topic = executor.submit(self.vector_db.search, query_embedding, "topic_preference", top_k, info)
            
            # Get user preferences directly (no vector search needed since there's only one per user)
            user_id = info.get("user_id") if info else None
            if user_id:
                future_user = executor.submit(self.vector_db.get_by_filter, "user_preference", {"user_id": user_id})
            else:
                future_user = None
            
            # Wait for all results
            explicit_prefs = future_explicit.result()
            implicit_prefs = future_implicit.result()
            topic_prefs = future_topic.result()
            user_prefs = future_user.result() if future_user else []
        
        explicit_prefs = [TextualMemoryItem(id=pref.id, memory=pref.payload.get("dialog_str", ""), 
                        metadata=PreferenceTextualMemoryMetadata(**pref.payload)) for pref in explicit_prefs if pref.payload["explicit_preference"]]
        implicit_prefs = [TextualMemoryItem(id=pref.id, memory=pref.payload.get("dialog_str", ""), 
                        metadata=PreferenceTextualMemoryMetadata(**pref.payload)) for pref in implicit_prefs if pref.payload["implicit_preference"]]
        topic_prefs = [TextualMemoryItem(id=pref.id, memory=pref.payload.get("center_dialog", ""), 
                        metadata=PreferenceTextualMemoryMetadata(**pref.payload)) for pref in topic_prefs if pref.payload["topic_preference"]]
        user_prefs = [TextualMemoryItem(id=pref.id, memory=pref.payload.get("user_preference", ""),
                        metadata=PreferenceTextualMemoryMetadata(**pref.payload)) for pref in user_prefs if pref.payload["user_preference"]]
            
        return explicit_prefs + implicit_prefs + topic_prefs + user_prefs

