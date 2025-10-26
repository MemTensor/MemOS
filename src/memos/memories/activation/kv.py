import os
import pickle

from datetime import datetime
from importlib.metadata import version

from packaging.version import Version
from transformers import DynamicCache

from memos.configs.memory import KVCacheMemoryConfig
from memos.dependency import require_python_package
from memos.llms.factory import LLMFactory
from memos.memories.activation.base import BaseActMemory
from memos.memories.activation.item import KVCacheItem
from memos.memories.textual.item import TextualMemoryItem


class KVCacheMemory(BaseActMemory):
    """
    Key-Value Cache Memory for activation memories.
    This memory type is designed to store and retrieve key-value caches.
    """

    @require_python_package(
        import_name="torch",
        install_link="https://pytorch.org/get-started/locally/",
    )
    def __init__(self, config: KVCacheMemoryConfig) -> None:
        """Initialize the KV Cache Memory with a configuration."""
        self.config = config
        self.llm = LLMFactory.from_config(config.extractor_llm)
        self.kv_cache_memories: dict[str, KVCacheItem] = {}

    def extract(self, text: str) -> KVCacheItem:
        """Extract memory based on the text.

        Uses the LLM to build KV caches from the provided text.

        Args:
            text: Input text to extract memory from

        Returns:
            Extracted memory item
        """
        # Build KV cache from the text using the LLM
        kv_cache = self.llm.build_kv_cache(text)

        # Create a KVCacheItem with the extracted cache
        cache_item = KVCacheItem(
            memory=kv_cache,
            metadata={"source_text": text, "extracted_at": datetime.now().isoformat()},
        )

        return cache_item

    def add(self, memories: list[KVCacheItem]) -> None:
        """Add memories to the KV cache memory.

        Args:
            memories: List of KVCacheItem to add
        """
        for memory in memories:
            self.kv_cache_memories[memory.id] = memory

    def get_cache(self, cache_ids: list[str]) -> DynamicCache | None:
        """Merge multiple KV caches into a single cache.

        Args:
            cache_ids: List of cache IDs to merge

        Returns:
            Merged DynamicCache or None if no caches found
        """
        caches_to_merge = []
        for cache_id in cache_ids:
            cache_item = self.kv_cache_memories.get(cache_id)
            if cache_item and cache_item.memory:
                caches_to_merge.append(cache_item.memory)

        if not caches_to_merge:
            return None

        return self._concat_caches(caches_to_merge)

    def get(self, memory_id: str) -> KVCacheItem | None:
        """Get a memory by its ID.

        Args:
            memory_id: ID of the memory to retrieve

        Returns:
            Memory dictionary or None if not found
        """
        return self.kv_cache_memories.get(memory_id)

    def get_by_ids(self, memory_ids: list[str]) -> list[KVCacheItem | None]:
        """Get memories by their IDs.

        Args:
            memory_ids: List of memory IDs to retrieve

        Returns:
            List of memory dictionaries or None for missing ones
        """
        results = []
        for memory_id in memory_ids:
            memory = self.get(memory_id)
            results.append(memory)
        return results

    def get_all(self) -> list[KVCacheItem]:
        """Get all memories.

        Returns:
            List of all KVCacheItems in the memory
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

    def from_textual_memory(self, mem: TextualMemoryItem) -> KVCacheItem:
        """
        Convert a TextualMemoryItem to a KVCacheItem.
        This method extracts the key-value cache from the textual memory.
        """
        # Build KV cache from the textual memory content
        kv_cache = self.llm.build_kv_cache(mem.memory)
        return KVCacheItem(memory=kv_cache, metadata=mem.metadata.model_dump())

    def load(self, dir: str) -> None:
        """Load memories from os.path.join(dir, self.config.memory_filename)

        Args:
            dir (str): The directory containing the memory files.
        """
        import torch

        file_path = os.path.join(dir, self.config.memory_filename)

        if not os.path.exists(file_path):
            # If file doesn't exist, start with empty memories
            return

        try:
            # Allow loading DynamicCache and KVCacheItem types
            torch.serialization.add_safe_globals([DynamicCache, KVCacheItem])

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

    def _concat_caches(self, caches: list[DynamicCache]) -> DynamicCache:
        """
        Faster concat merge: for each layer, gather all caches' tensors
        and do a single torch.cat per layer.
        """
        import torch

        assert caches, "Need at least one cache"
        if len(caches) == 1:
            return caches[0]

        merged = DynamicCache()
        num_layers = len(caches[0].key_cache)

        if Version(version("transformers")) >= Version("4.54.0"):
            merged.append_new_layers(num_layers - 1)
            for layer in range(num_layers):
                # gather all K and V for this layer
                keys = [c.layers[layer].keys for c in caches]
                vals = [c.layers[layer].values for c in caches]
                # single concat per layer
                merged.layers[layer].keys = torch.cat(keys, dim=-2)
                merged.layers[layer].values = torch.cat(vals, dim=-2)

        else:
            for layer in range(num_layers):
                # gather all K and V for this layer
                keys = [c.key_cache[layer] for c in caches]
                vals = [c.value_cache[layer] for c in caches]
                # single concat per layer
                merged.key_cache.append(torch.cat(keys, dim=-2))
                merged.value_cache.append(torch.cat(vals, dim=-2))

        return merged


def move_dynamic_cache_htod(dynamic_cache: DynamicCache, device: str) -> DynamicCache:
    """
    Move DynamicCache from CPU to GPU device.
    Compatible with both old and new transformers versions.

    In SimpleMemChat.run(), if self.config.enable_activation_memory is enabled,
    we load serialized kv cache from a [class KVCacheMemory] object, which has a kv_cache_memories on CPU.
    So before inferring with DynamicCache, we should move it to GPU in-place first.
    """
    # Handle compatibility between old and new transformers versions
    if hasattr(dynamic_cache, "layers"):
        # New version: use layers attribute
        for layer in dynamic_cache.layers:
            if hasattr(layer, "key_cache") and layer.key_cache is not None:
                layer.key_cache = layer.key_cache.to(device, non_blocking=True)
            if hasattr(layer, "value_cache") and layer.value_cache is not None:
                layer.value_cache = layer.value_cache.to(device, non_blocking=True)
            elif hasattr(layer, "keys") and hasattr(layer, "values"):
                # Alternative attribute names in some versions
                if layer.keys is not None:
                    layer.keys = layer.keys.to(device, non_blocking=True)
                if layer.values is not None:
                    layer.values = layer.values.to(device, non_blocking=True)
    elif hasattr(dynamic_cache, "key_cache") and hasattr(dynamic_cache, "value_cache"):
        # Old version: use key_cache and value_cache attributes
        for i in range(len(dynamic_cache.key_cache)):
            if dynamic_cache.key_cache[i] is not None:
                dynamic_cache.key_cache[i] = dynamic_cache.key_cache[i].to(
                    device, non_blocking=True
                )
            if dynamic_cache.value_cache[i] is not None:
                dynamic_cache.value_cache[i] = dynamic_cache.value_cache[i].to(
                    device, non_blocking=True
                )
    return dynamic_cache
