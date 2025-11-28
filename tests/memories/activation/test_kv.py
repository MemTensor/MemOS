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


def make_filled_cache():
    # Create a DynamicCache with at least one dummy tensor layer, supporting new/old APIs
    cache = DynamicCache()
    if hasattr(cache, "layers") and cache.layers is not None:
        # For new API, append a layer-like object with keys/values tensors
        class _Layer:
            def __init__(self):
                self.keys = torch.zeros(1, 2, 3)
                self.values = torch.zeros(1, 2, 3)

        cache.layers.append(_Layer())
    else:
        # Legacy API
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
    # Check the number of layers in merged cache (new or old API)
    if hasattr(merged, "layers") and merged.layers is not None:
        assert len(merged.layers) == 1
        assert getattr(merged.layers[0], "keys", None) is not None
        assert getattr(merged.layers[0], "values", None) is not None
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
