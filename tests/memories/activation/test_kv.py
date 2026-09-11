from unittest.mock import MagicMock

import pytest
import torch

from transformers import DynamicCache

from memos.configs.memory import KVCacheMemoryConfig
from memos.memories.activation.item import KVCacheItem
from memos.memories.activation.kv import KVCacheMemory, clone_dynamic_cache


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


def make_filled_cache():
    # Create a DynamicCache with at least one dummy tensor layer
    cache = DynamicCache()
    cache.key_cache.append(torch.zeros(1, 2, 3))
    cache.value_cache.append(torch.zeros(1, 2, 3))
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

def test_get_cache_single_item_returns_independent_copy(kv_memory):
    # Regression for issue #2301: with a single cache, get_cache used to hand
    # out the stored object, so generation appended new K/V tensors into the
    # store and the activation memory grew every turn.
    item = KVCacheItem(memory=make_filled_cache())
    kv_memory.add([item])

    merged = kv_memory.get_cache([item.id])
    assert merged is not item.memory

    # Simulate generation appending to the handed-out cache.
    merged.key_cache[0] = torch.cat([merged.key_cache[0], torch.ones(1, 1, 3)], dim=-2)
    assert item.memory.key_cache[0].shape == (1, 2, 3)


def test_get_cache_multi_item_merge_does_not_alias_inputs(kv_memory):
    item1 = KVCacheItem(memory=make_filled_cache())
    item2 = KVCacheItem(memory=make_filled_cache())
    kv_memory.add([item1, item2])

    merged = kv_memory.get_cache([item1.id, item2.id])
    assert merged is not item1.memory
    assert merged is not item2.memory


def test_clone_dynamic_cache_copies_legacy_tensors():
    cache = make_filled_cache()
    cloned = clone_dynamic_cache(cache)

    assert cloned is not cache
    assert cloned.key_cache[0] is not cache.key_cache[0]
    assert torch.equal(cloned.key_cache[0], cache.key_cache[0])

    cloned.key_cache[0] = torch.ones(1, 5, 3)
    assert cache.key_cache[0].shape == (1, 2, 3)


def test_clone_dynamic_cache_handles_layers_structure():
    # transformers >= 4.56 exposes DynamicCache.layers with per-layer keys/values.
    class FakeLayer:
        def __init__(self):
            self.keys = None
            self.values = None

    class FakeLayeredCache:
        pass

    cache = FakeLayeredCache()
    cache.layers = [FakeLayer()]
    cache.layers[0].keys = torch.zeros(1, 2, 3)
    cache.layers[0].values = torch.zeros(1, 2, 4)

    cloned = clone_dynamic_cache(cache)
    assert isinstance(cloned, DynamicCache)
    assert len(cloned.layers) == 1
    assert cloned.layers[0].keys is not cache.layers[0].keys
    assert torch.equal(cloned.layers[0].keys, cache.layers[0].keys)

    cloned.layers[0].keys = torch.ones(2, 2, 3)
    assert cache.layers[0].keys.shape == (1, 2, 3)
