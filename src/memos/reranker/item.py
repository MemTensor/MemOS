from typing import Any
from pydantic import BaseModel


class DialoguePair(BaseModel):
    """Represents a single dialogue pair extracted from sources."""
    
    pair_id: str  # Unique identifier for this dialogue pair
    memory_id: str  # ID of the source TextualMemoryItem
    memory: str
    pair_index: int  # Index of this pair within the source memory's dialogue
    user_msg: str | dict[str, Any]  # User message content
    assistant_msg: str | dict[str, Any]  # Assistant message content
    combined_text: str  # The concatenated text used for ranking
    
    def extract_content(self, msg: str | dict[str, Any]) -> str:
        """Extract content from message, handling both string and dict formats."""
        if isinstance(msg, dict):
            return msg.get('content', str(msg))
        return str(msg)
    
    @property
    def user_content(self) -> str:
        """Get user message content as string."""
        return self.extract_content(self.user_msg)
    
    @property
    def assistant_content(self) -> str:
        """Get assistant message content as string."""
        return self.extract_content(self.assistant_msg)


class DialogueRankingTracker:
    """Tracks dialogue pairs and their rankings for memory reconstruction."""
    
    def __init__(self):
        self.dialogue_pairs: list[DialoguePair] = []
    
    def add_dialogue_pair(
        self, 
        memory_id: str, 
        pair_index: int,
        user_msg: str | dict[str, Any], 
        assistant_msg: str | dict[str, Any],
        memory: str
    ) -> str:
        """Add a dialogue pair and return its unique ID."""
        pair_id = f"{memory_id}_{pair_index}"
        
        # Extract content for ranking
        def extract_content(msg: str | dict[str, Any]) -> str:
            if isinstance(msg, dict):
                return msg.get('content', str(msg))
            return str(msg)
        
        user_content = extract_content(user_msg)
        assistant_content = extract_content(assistant_msg)
        combined_text = f"{user_content}\n{assistant_content}"
        
        dialogue_pair = DialoguePair(
            pair_id=pair_id,
            memory_id=memory_id,
            pair_index=pair_index,
            user_msg=user_msg,
            assistant_msg=assistant_msg,
            combined_text=combined_text,
            memory=memory
        )
        
        self.dialogue_pairs.append(dialogue_pair)
        
        return pair_id
    
    def get_documents_for_ranking(self, concat_memory: bool = True) -> list[str]:
        """Get the combined text documents for ranking."""
        return [(pair.memory + "\n\n" + pair.combined_text) for pair in self.dialogue_pairs]
    
    def get_dialogue_pair_by_index(self, index: int) -> DialoguePair | None:
        """Get dialogue pair by its index in the ranking results."""
        if 0 <= index < len(self.dialogue_pairs):
            return self.dialogue_pairs[index]
        return None
    
    def reconstruct_memory_items(
        self, 
        ranked_indices: list[int], 
        scores: list[float],
        original_memory_items: dict[str, Any],
        top_k: int
    ) -> list[tuple[Any, float]]:
        """
        Reconstruct TextualMemoryItem objects from ranked dialogue pairs.
        
        Args:
            ranked_indices: List of dialogue pair indices sorted by relevance
            scores: Corresponding relevance scores
            original_memory_items: Dict mapping memory_id to original TextualMemoryItem
            top_k: Maximum number of items to return
            
        Returns:
            List of (reconstructed_memory_item, aggregated_score) tuples
        """
        from collections import defaultdict
        from copy import deepcopy
        
        # Group ranked pairs by memory_id
        memory_groups = defaultdict(list)
        memory_scores = defaultdict(list)
        
        for idx, score in zip(ranked_indices[:top_k * 3], scores[:top_k * 3]):  # Take more pairs to ensure we have enough memories
            dialogue_pair = self.get_dialogue_pair_by_index(idx)
            if dialogue_pair:
                memory_groups[dialogue_pair.memory_id].append(dialogue_pair)
                memory_scores[dialogue_pair.memory_id].append(score)
        
        # Reconstruct memory items
        reconstructed_items = []
        
        for memory_id, pairs in memory_groups.items():
            if memory_id not in original_memory_items:
                continue
                
            # Create a copy of the original memory item
            original_item = original_memory_items[memory_id]
            reconstructed_item = deepcopy(original_item)
            
            # Sort pairs by their original index to maintain order
            pairs.sort(key=lambda p: p.pair_index)
            
            # Reconstruct sources from selected dialogue pairs
            new_sources = []
            for pair in pairs[:1]:
                new_sources.extend([pair.user_msg, pair.assistant_msg])
            
            # Update the metadata sources
            if hasattr(reconstructed_item.metadata, 'sources'):
                reconstructed_item.metadata.sources = new_sources
            
            # Calculate aggregated score (e.g., max, mean, or weighted average)
            pair_scores = memory_scores[memory_id]
            aggregated_score = max(pair_scores) if pair_scores else 0.0
            
            reconstructed_items.append((reconstructed_item, aggregated_score))
        
        # Sort by aggregated score and return top_k
        reconstructed_items.sort(key=lambda x: x[1], reverse=True)
        return reconstructed_items[:top_k] 