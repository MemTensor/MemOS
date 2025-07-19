import os
import pickle

from datetime import datetime

from memos.configs.memory import KVCacheMemoryConfig
from memos.dependency import require_python_package
from memos.llms.factory import LLMFactory
from memos.memories.activation.base import BaseActMemory
from memos.memories.activation.item import VLLMKVCacheItem
from memos.memories.textual.item import TextualMemoryItem


class VLLMKVCacheMemory(BaseActMemory):
    """
    VLLM Key-Value Cache Memory for activation memories.
    This memory type is designed to store and retrieve prompt strings for vLLM KV cache preloading.
    Unlike traditional KV cache that stores DynamicCache objects, vLLM handles cache on server side.
    """

    @require_python_package(
        import_name="torch",
        install_link="https://pytorch.org/get-started/locally/",
    )
    def __init__(self, config: KVCacheMemoryConfig) -> None:
        """Initialize the VLLM KV Cache Memory with a configuration."""
        self.config = config
        self.llm = LLMFactory.from_config(config.extractor_llm)
        self.kv_cache_memories: dict[str, VLLMKVCacheItem] = {}

    def extract(self, text: str) -> VLLMKVCacheItem:
        """Extract memory based on the text.

        Uses the LLM to build vLLM KV cache from the provided text.
        For vLLM, this means preloading the KV cache on the server side.

        Args:
            text: Input text to extract memory from

        Returns:
            Extracted VLLM KV cache item with prompt string
        """
        # Build vLLM KV cache from the text using the LLM
        # This preloads the cache on the vLLM server and returns the prompt
        prompt = self.llm.build_vllm_kv_cache(text)

        # Create a VLLMKVCacheItem with the extracted prompt
        cache_item = VLLMKVCacheItem(
            memory=prompt,
            metadata={"source_text": text, "extracted_at": datetime.now().isoformat()},
        )

        return cache_item

    def add(self, memories: list[VLLMKVCacheItem]) -> None:
        """Add memories to the VLLM KV cache memory.

        Args:
            memories: List of VLLMKVCacheItem to add
        """
        for memory in memories:
            self.kv_cache_memories[memory.id] = memory

    def get_cache(self, cache_ids: list[str]) -> str | None:
        """Get the prompt string for the most recent cache.

        Since vLLM handles KV cache on server side, we return the prompt string
        that can be used for generation. For multiple caches, we return the most recent one.

        Args:
            cache_ids: List of cache IDs to consider

        Returns:
            Prompt string for the most recent cache or None if no caches found
        """
        if not cache_ids:
            return None

        # For vLLM, we typically want the most recent cache
        # Return the prompt from the last cache ID in the list
        latest_cache_id = cache_ids[-1]
        cache_item = self.kv_cache_memories.get(latest_cache_id)

        if cache_item and cache_item.memory:
            return cache_item.memory

        return None

    def get(self, memory_id: str) -> VLLMKVCacheItem | None:
        """Get a memory by its ID.

        Args:
            memory_id: ID of the memory to retrieve

        Returns:
            VLLMKVCacheItem or None if not found
        """
        return self.kv_cache_memories.get(memory_id)

    def get_by_ids(self, memory_ids: list[str]) -> list[VLLMKVCacheItem | None]:
        """Get memories by their IDs.

        Args:
            memory_ids: List of memory IDs to retrieve

        Returns:
            List of VLLMKVCacheItem or None for missing ones
        """
        results = []
        for memory_id in memory_ids:
            memory = self.get(memory_id)
            results.append(memory)
        return results

    def get_all(self) -> list[VLLMKVCacheItem]:
        """Get all memories.

        Returns:
            List of all VLLMKVCacheItems in the memory
        """
        return list(self.kv_cache_memories.values())

    def delete(self, memory_ids: list[str]) -> None:
        """Delete memories by their IDs.

        Args:
            memory_ids: List of memory IDs to delete
        """
        for memory_id in memory_ids:
            self.kv_cache_memories.pop(memory_id, None)

    def delete_all(self) -> None:
        """Delete all memories."""
        self.kv_cache_memories.clear()

    def from_textual_memory(self, mem: TextualMemoryItem) -> VLLMKVCacheItem:
        """
        Convert a TextualMemoryItem to a VLLMKVCacheItem.
        This method extracts the prompt string from the textual memory.
        """
        # Build vLLM KV cache from the textual memory content
        prompt = self.llm.build_vllm_kv_cache(mem.memory)
        return VLLMKVCacheItem(memory=prompt, metadata=mem.metadata.model_dump())

    def load(self, dir: str) -> None:
        """Load memories from os.path.join(dir, self.config.memory_filename)

        Args:
            dir (str): The directory containing the memory files.
        """
        file_path = os.path.join(dir, self.config.memory_filename)

        if not os.path.exists(file_path):
            # If file doesn't exist, start with empty memories
            return

        try:
            # Allow loading VLLMKVCacheItem types
            import torch

            torch.serialization.add_safe_globals([VLLMKVCacheItem])

            with open(file_path, "rb") as f:
                data = pickle.load(f)

            if isinstance(data, dict):
                # Load memories, handle both old and new formats
                if "kv_cache_memories" in data:
                    memories = data["kv_cache_memories"]
                    if isinstance(memories, list):
                        # Convert list to dict format
                        self.kv_cache_memories = {item.id: item for item in memories}
                    else:
                        self.kv_cache_memories = memories
                else:
                    # Reset to empty if no memories in data
                    self.kv_cache_memories = {}
            elif isinstance(data, list):
                # Backward compatibility: convert list to dict
                self.kv_cache_memories = {item.id: item for item in data}
            else:
                # Reset to empty if data format is unexpected
                self.kv_cache_memories = {}

        except (EOFError, pickle.UnpicklingError, Exception):
            # If loading fails, start with empty memories
            self.kv_cache_memories = {}

    def dump(self, dir: str) -> None:
        """Dump memories to os.path.join(dir, self.config.memory_filename)

        Args:
            dir (str): The directory where the memory files will be saved.
        """
        file_path = os.path.join(dir, self.config.memory_filename)

        # Create directory if it doesn't exist
        os.makedirs(dir, exist_ok=True)

        # Prepare data to save (only memories)
        data = {"kv_cache_memories": self.kv_cache_memories}

        with open(file_path, "wb") as f:
            pickle.dump(data, f, protocol=pickle.HIGHEST_PROTOCOL)

    def preload_kv_cache(self, cache_ids: list[str]) -> None:
        """
        Preload KV cache on vLLM server for the given cache IDs.
        This method calls build_vllm_kv_cache for each cache to ensure
        the KV cache is loaded on the server side.

        Args:
            cache_ids: List of cache IDs to preload
        """
        for cache_id in cache_ids:
            cache_item = self.kv_cache_memories.get(cache_id)
            if cache_item and cache_item.memory:
                # Re-preload the KV cache on the server
                self.llm.build_vllm_kv_cache(cache_item.memory)
