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
    """Create a DynamicCache with dummy tensors, on any transformers version.

    This previously appended to ``cache.key_cache`` directly. That attribute was
    removed in transformers 4.57 in favour of ``cache.layers``, so
    ``test_get_cache_merge`` and ``test_delete_and_get_all`` failed with
    ``AttributeError: 'DynamicCache' object has no attribute 'key_cache'`` on any
    current install. Going through the public ``update`` API works on both the
    old and new layouts -- and, unlike direct assignment, produces a properly
    initialized cache, which is what makes the merge assertions meaningful.
    """
    cache = DynamicCache()
    for layer_idx in range(n_layers):
        k = torch.zeros(1, 2, seq_len, 4)
        v = torch.zeros(1, 2, seq_len, 4)
        cache.update(k, v, layer_idx)
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
    # Check the number of layers in the merged cache. ``key_cache`` was removed
    # in transformers 4.57; ``layers`` is the current layout, so accept either.
    if hasattr(merged, "layers"):
        assert len(merged.layers) == 1
        assert merged.layers[0].keys.shape[-2] == 6
        assert merged.layers[0].values.shape[-2] == 6
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


def test_concat_caches_preserves_seq_length(kv_memory):
    """A merged cache must report the summed length, not zero.

    Regression test for the merged cache being silently discarded. A layer built
    by ``layer_cls()`` and populated by direct attribute assignment is never
    marked initialized, and on transformers >= 4.57
    ``DynamicLayer.get_seq_length()`` short-circuits to 0 for an uninitialized
    layer regardless of the tensors it holds. The merged cache therefore looked
    empty and every merged token was dropped on the first forward pass, with no
    error raised.

    Before the fix this asserts 0 == 7 and fails on transformers >= 4.57; it
    passes on 4.56 and below, which is why it presented as a version nuisance.
    """
    a = make_filled_cache(seq_len=3, n_layers=2)
    b = make_filled_cache(seq_len=4, n_layers=2)

    merged = kv_memory._concat_caches([a, b])

    assert merged.get_seq_length() == 7, (
        f"merged cache reports {merged.get_seq_length()} tokens, expected 7 "
        f"(3 + 4); a cache reporting 0 is silently discarded by the model"
    )
    # and the tensors really are concatenated, not just the bookkeeping patched
    if hasattr(merged, "layers"):
        assert merged.layers[0].keys.shape[-2] == 7
        assert merged.layers[0].values.shape[-2] == 7
