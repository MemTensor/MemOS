import hashlib
import json
import os
import pickle

from datetime import datetime
from typing import Any

from transformers import DynamicCache

from memos.configs.memory import KVCacheMemoryConfig
from memos.dependency import require_python_package
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.memories.activation.base import BaseActMemory
from memos.memories.activation.item import KVCacheItem
from memos.memories.textual.item import TextualMemoryItem


logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Producer fingerprint helpers (see openspec change 2300-... for the contract)
# ---------------------------------------------------------------------------

# The strict subset of fingerprint fields we compare on load. A field mismatches
# only if both sides are non-None and unequal — unknown fields never fail.
_STRICT_FIELDS: tuple[str, ...] = (
    "model_name_or_path",
    "config_fingerprint",
    "tokenizer_fingerprint",
    "torch_dtype",
    "quantization",
)


def _compute_producer_fingerprint(llm: Any) -> dict[str, Any]:
    """Return an identity fingerprint for the LLM that produced a KV cache.

    Every field is best-effort — a missing attribute becomes ``None`` rather
    than an exception. The loader treats ``None`` as unknown, not as mismatch,
    so a partial fingerprint stays useful.
    """
    fp: dict[str, Any] = {
        "model_name_or_path": None,
        "backend": None,
        "config_fingerprint": None,
        "tokenizer_fingerprint": None,
        "torch_dtype": None,
        "quantization": None,
        "architectures": None,
        "num_hidden_layers": None,
        "num_kv_heads": None,
        "head_dim": None,
        "transformers_version": None,
    }

    llm_config = getattr(llm, "config", None)
    if llm_config is not None:
        fp["model_name_or_path"] = getattr(llm_config, "model_name_or_path", None)
        fp["backend"] = type(llm_config).__name__

    model = getattr(llm, "model", None)
    if model is not None:
        try:
            model_config = getattr(model, "config", None)
            if model_config is not None:
                to_diff_dict = getattr(model_config, "to_diff_dict", None)
                if callable(to_diff_dict):
                    diff = to_diff_dict()
                    fp["config_fingerprint"] = hashlib.sha256(
                        json.dumps(diff, sort_keys=True, default=str).encode()
                    ).hexdigest()
                quant = getattr(model_config, "quantization_config", None)
                fp["quantization"] = str(quant) if quant is not None else None
                arch = getattr(model_config, "architectures", None)
                if arch:
                    fp["architectures"] = list(arch)
                fp["num_hidden_layers"] = getattr(model_config, "num_hidden_layers", None)
                fp["num_kv_heads"] = getattr(model_config, "num_key_value_heads", None) or getattr(
                    model_config, "num_attention_heads", None
                )
                head_dim = getattr(model_config, "head_dim", None)
                if head_dim is None:
                    hidden = getattr(model_config, "hidden_size", None)
                    n_heads = getattr(model_config, "num_attention_heads", None)
                    if hidden and n_heads:
                        head_dim = hidden // n_heads
                fp["head_dim"] = head_dim
            dtype = getattr(model, "dtype", None)
            if dtype is not None:
                fp["torch_dtype"] = str(dtype)
        except Exception:
            logger.warning(
                "Failed to introspect HF model config for KV cache fingerprint",
                exc_info=True,
            )

    tokenizer = getattr(llm, "tokenizer", None)
    if tokenizer is not None:
        try:
            backend_tokenizer = getattr(tokenizer, "backend_tokenizer", None)
            if backend_tokenizer is not None and hasattr(backend_tokenizer, "to_str"):
                fp["tokenizer_fingerprint"] = hashlib.sha256(
                    backend_tokenizer.to_str().encode()
                ).hexdigest()
        except Exception:
            logger.warning(
                "Failed to compute tokenizer fingerprint for KV cache",
                exc_info=True,
            )

    try:
        import transformers

        fp["transformers_version"] = transformers.__version__
    except Exception:
        pass

    return fp


def _fingerprint_mismatch_reasons(saved: dict[str, Any] | None, live: dict[str, Any]) -> list[str]:
    """Return a list of human-readable mismatch reasons.

    Empty list means "safe to install" (either every field matched or one side
    was unknown). Only strict fields participate in the decision.
    """
    if not isinstance(saved, dict):
        return []
    reasons: list[str] = []
    for field in _STRICT_FIELDS:
        s_val = saved.get(field)
        l_val = live.get(field)
        if s_val is None or l_val is None:
            continue
        if s_val != l_val:
            reasons.append(f"{field}: saved={s_val!r} live={l_val!r}")
    return reasons


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

    def _producer_fingerprint(self) -> dict[str, Any]:
        """Fingerprint of the LLM currently wired into this memory."""
        return _compute_producer_fingerprint(self.llm)

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
            metadata={
                "source_text": text,
                "extracted_at": datetime.now().isoformat(),
                "producer": self._producer_fingerprint(),
            },
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
        metadata = mem.metadata.model_dump()
        metadata["producer"] = self._producer_fingerprint()
        return KVCacheItem(memory=kv_cache, metadata=metadata)

    def _verify_and_filter(self, memories: dict[str, KVCacheItem]) -> dict[str, KVCacheItem]:
        """Compare each item's saved producer fingerprint against the live LLM.

        Drops items whose fingerprint disagrees on any strict field. Items
        without a fingerprint are kept with a warning (backward compatibility
        with pre-2.0.30 caches).
        """
        if not memories:
            return {}

        # Live fingerprint may itself fail to compute for an unusual backend.
        # In that case skip verification with a warning — do not regress
        # loading reliability.
        try:
            live_fp = self._producer_fingerprint()
        except Exception:
            logger.warning(
                "Failed to compute live producer fingerprint; loading KV cache without verification",
                exc_info=True,
            )
            return memories

        verified: dict[str, KVCacheItem] = {}
        for item_id, item in memories.items():
            item_metadata = getattr(item, "metadata", None) or {}
            saved_fp = item_metadata.get("producer") if isinstance(item_metadata, dict) else None
            if saved_fp is None:
                logger.warning(
                    "KV cache item %s has no producer fingerprint (pre-2.0.30 cache); loading unchecked",
                    item_id,
                )
                verified[item_id] = item
                continue
            reasons = _fingerprint_mismatch_reasons(saved_fp, live_fp)
            if reasons:
                logger.error(
                    "KV cache item %s dropped: producer fingerprint mismatch (%s)",
                    item_id,
                    "; ".join(reasons),
                )
                continue
            verified[item_id] = item
        return verified

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
                        candidate = {item.id: item for item in memories}
                    else:
                        candidate = memories
                    self.kv_cache_memories = self._verify_and_filter(candidate)
                else:
                    # Reset to empty if no memories in data
                    self.kv_cache_memories = {}
            elif isinstance(data, list):
                # Backward compatibility: convert list to dict
                candidate = {item.id: item for item in data}
                self.kv_cache_memories = self._verify_and_filter(candidate)
            else:
                # Reset to empty if data format is unexpected
                self.kv_cache_memories = {}

        except (EOFError, pickle.UnpicklingError, Exception):
            # Corrupt or incompatible cache — log the reason so the failure is
            # distinguishable from an empty cache in production. Loader stays
            # resilient by resetting to an empty dict.
            logger.warning(
                "Failed to load KV cache from %s; resetting to empty",
                file_path,
                exc_info=True,
            )
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

        # Check for new structure (layers)
        if hasattr(caches[0], "layers"):
            num_layers = len(caches[0].layers)

            # Ensure merged has layers attribute and populate it
            if not hasattr(merged, "layers"):
                merged.layers = []

            if num_layers > 0:
                # Get the class of the layer from the first cache
                # We assume all caches use the same layer class
                layer_cls = type(caches[0].layers[0])

                # Populate merged.layers
                while len(merged.layers) < num_layers:
                    merged.layers.append(layer_cls())

            for layer in range(num_layers):
                # gather all K and V for this layer
                keys = [c.layers[layer].keys for c in caches]
                vals = [c.layers[layer].values for c in caches]
                # single concat per layer
                merged.layers[layer].keys = torch.cat(keys, dim=-2)
                merged.layers[layer].values = torch.cat(vals, dim=-2)

        # Check for old structure (key_cache)
        elif hasattr(caches[0], "key_cache"):
            num_layers = len(caches[0].key_cache)

            for layer in range(num_layers):
                # gather all K and V for this layer
                keys = [c.key_cache[layer] for c in caches]
                vals = [c.value_cache[layer] for c in caches]
                # single concat per layer
                merged.key_cache.append(torch.cat(keys, dim=-2))
                merged.value_cache.append(torch.cat(vals, dim=-2))

        else:
            raise AttributeError(
                "DynamicCache object has neither 'layers' nor 'key_cache' attributes"
            )

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
