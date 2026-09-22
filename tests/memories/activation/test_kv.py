from unittest.mock import MagicMock

import pytest
import torch

from transformers import DynamicCache

from memos.configs.memory import KVCacheMemoryConfig
from memos.memories.activation.item import KVCacheItem
from memos.memories.activation.kv import KVCacheMemory


@pytest.fixture
def dummy_config():
    # Minimal config mock for KVCacheMemory
    config = MagicMock(spec=KVCacheMemoryConfig)
    config.extractor_llm = MagicMock()
    config.memory_filename = "test_kv_cache.pkl"
    return config


@pytest.fixture
def kv_memory(dummy_config):
    # Patch LLMFactory to avoid real LLM calls
    with pytest.MonkeyPatch.context() as m:
        from memos.llms import factory

        m.setattr(
            factory.LLMFactory,
            "from_config",
            lambda cfg: MagicMock(build_kv_cache=lambda x: DynamicCache()),
        )
        yield KVCacheMemory(dummy_config)


def make_filled_cache(seq_len: int = 3, n_layers: int = 1):
    """Create a DynamicCache with dummy tensors, on any transformers version."""
    cache = DynamicCache()
    for layer_idx in range(n_layers):
        cache.update(torch.zeros(1, 2, seq_len, 4), torch.zeros(1, 2, seq_len, 4), layer_idx)
    return cache


def test_extract_and_add_and_get(kv_memory):
    # Test extract, add, and get functionality
    item = kv_memory.extract("hello world")
    assert isinstance(item, KVCacheItem)
    assert isinstance(item.memory, DynamicCache)
    kv_memory.add([item])
    got = kv_memory.get(item.id)
    assert got is item


def test_get_cache_merge(kv_memory):
    # Test merging multiple KVCacheItems into a single DynamicCache
    item1 = KVCacheItem(memory=make_filled_cache())
    item2 = KVCacheItem(memory=make_filled_cache())
    kv_memory.add([item1, item2])
    merged = kv_memory.get_cache([item1.id, item2.id])
    assert isinstance(merged, DynamicCache)
    # Check the number of layers in merged key/value cache
    if hasattr(merged, "layers"):
        assert len(merged.layers) == 1
    else:
        assert len(merged.key_cache) == 1
        assert len(merged.value_cache) == 1


def test_delete_and_get_all(kv_memory):
    # Test delete and get_all functionality
    item = KVCacheItem(memory=make_filled_cache())
    kv_memory.add([item])
    assert item in kv_memory.get_all()
    kv_memory.delete([item.id])
    assert kv_memory.get(item.id) is None
    kv_memory.add([item])
    kv_memory.delete_all()
    assert kv_memory.get_all() == []


def test_from_textual_memory(kv_memory):
    # Test conversion from textual memory to KVCacheItem
    class DummyTextualMemory:
        memory = "foo"
        metadata = MagicMock(model_dump=lambda: {"bar": 1})

    item = kv_memory.from_textual_memory(DummyTextualMemory())
    assert isinstance(item, KVCacheItem)
    assert item.metadata["bar"] == 1


def test_get_cache_does_not_alias_stored_memory(kv_memory):
    """A cache handed to the caller must not be the stored object itself.

    ``get_cache`` returned ``caches[0]`` directly whenever a single id was
    requested. The caller passes that cache to ``generate``, which appends to it
    in place, so the saved activation memory grew on every chat turn -- observed
    as a stored length of 6 -> 19 -> 32 -> 45 across three turns. Nothing in the
    API suggests retrieving a memory mutates it.

    Simulating ``generate`` by appending to the returned cache must leave the
    stored item unchanged. Fails before this change, passes after.
    """
    item = KVCacheItem(memory=make_filled_cache(seq_len=5, n_layers=2))
    kv_memory.add([item])
    stored_len_before = kv_memory.get(item.id).memory.get_seq_length()

    handed_out = kv_memory.get_cache([item.id])
    assert handed_out is not item.memory, "get_cache returned the stored object itself"

    # what generate() does: append one step of new keys/values
    for layer_idx in range(2):
        handed_out.update(torch.zeros(1, 2, 1, 4), torch.zeros(1, 2, 1, 4), layer_idx)

    stored_len_after = kv_memory.get(item.id).memory.get_seq_length()
    assert stored_len_after == stored_len_before, (
        f"stored memory grew {stored_len_before} -> {stored_len_after} because the "
        f"caller mutated the cache it was handed"
    )
