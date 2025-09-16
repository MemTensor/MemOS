from abc import ABC, abstractmethod
from typing import Any
from datetime import datetime
from memos.types import MessageList
from memos.vec_dbs.item import VecDBItem
from memos.memories.textual.prefer_text_memory.naive_op import NaiveOp
from memos.memories.textual.prefer_text_memory.clustering import HDBSCANClusterer


class BaseUpdater(ABC):
    """Abstract base class for updaters."""
    
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
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
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive updater."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    def update(self, new_dialog: MessageList, *args, **kwargs) -> None:
        """Update the dialog to the vector db, fast update.
        Args:
            new_dialog (MessageList): The new dialog to update.
            *args: Additional positional arguments.
            **kwargs: Additional keyword arguments.
        """
        naive_op = NaiveOp(self.llm_provider, self.embedder, self.vector_db)
        basic_info = naive_op.extract_basic_info(new_dialog)
        topic_info = naive_op.extract_topic_info(new_dialog)
        explicit_pref = naive_op.extract_explicit_preference(new_dialog)

        dialogue_vectors = naive_op.generate_dialogue_vectors([basic_info])
        concat_info = naive_op.concat_infos([basic_info], [explicit_pref], [topic_info], dialogue_vectors)[0]

        vec_db_item = VecDBItem(
            id=concat_info.get("dialog_id", ""),
            vector=concat_info.get("dialog_vector", []),
            payload={
                "dialog_id": concat_info.get("dialog_id", ""),
                "dialog_msgs": concat_info.get("dialog_msgs", []),
                "dialog_str": concat_info.get("dialog_str", ""),
                "created_at": concat_info.get("created_at", datetime.now().isoformat()),
                "user_id": concat_info.get("user_id", ""),
                "type": "explicit_preference"
            }
        )
        
        # retrieve the dialog
        dialog_vector = dialogue_vectors[0]["dialog_vector"]  # This is already a List[float]
        dialog_items = self.vector_db.search(dialog_vector, "explicit_preference", top_k=1)
        
        # Extract dialog_str from retrieved items
        if dialog_items:
            # Get the first (most similar) item
            retrieved_item = dialog_items[0]
            # Extract dialog_str from payload
            old_msgs = retrieved_item.payload.get("dialog_msgs", "")
            is_same = naive_op.judge_update_or_add(old_msgs, new_dialog)
            if is_same:
                # Extract ID from the retrieved item
                item_id = retrieved_item.id
                self.vector_db.update("explicit_preference", item_id, vec_db_item)
                return

        self.vector_db.add("explicit_preference", vec_db_item)
    

    def slow_update(self):
        """Retrieve all dialog info from the expicit preference collection, 
        and reconstruct the implicit preference collection, topic collection and user preference collection.
        """
        clusterer = HDBSCANClusterer()
        naive_op = NaiveOp(self.llm_provider, self.embedder, self.vector_db)
        all_data = self.vector_db.get_all("explicit_preference")

        user_id = all_data[0].payload.get("user_id", "")

        # Convert VecDBItem list to whole_infos format
        whole_infos = [item.payload for item in all_data]
        
        # Perform clustering
        implicit_clusters = naive_op.implicit_cluster(clusterer, whole_infos)
        topic_clusters = naive_op.topic_cluster(clusterer, whole_infos)
        
        # Extract implicit preferences
        implicit_clusters = naive_op.extract_implicit_preferences(implicit_clusters)
        
        # Extract topic preferences
        topic_clusters = naive_op.extract_topic_preferences(topic_clusters)
        
        # Extract user preferences
        user_preferences = naive_op.extract_user_preferences(topic_clusters)
        
        # refresh the implicit preference collection, topic collection and user preference collection
        self.vector_db.delete_collection("implicit_preference")
        self.vector_db.delete_collection("topic_preference")
        self.vector_db.delete_collection("user_preference")

        self.vector_db.create_collection_by_name("implicit_preference")
        self.vector_db.create_collection_by_name("topic_preference")
        self.vector_db.create_collection_by_name("user_preference")


        # Store all preferences in memory
        naive_op.store_preferences(
            explicit_prefs=whole_infos,
            implicit_prefs=implicit_clusters,
            topic_prefs=topic_clusters,
            user_prefs=user_preferences,
            user_id=user_id,
        )
        
        # Return summary of built memory
        return naive_op.generate_memory_summary(
            explicit_prefs=whole_infos,
            implicit_prefs=implicit_clusters,
            topic_prefs=topic_clusters,
            user_prefs=user_preferences,
        )

        

