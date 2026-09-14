from unittest.mock import MagicMock

import pytest
import torch

from transformers import DynamicCache

from memos.configs.memory import KVCacheMemoryConfig
from memos.memories.activation.item import KVCacheItem
from memos.memories.activation.kv import KVCacheMemory, clone_dynamic_cache
from tests.cache_helpers import (
    cache_keys,
    cache_layer_count,
    cache_value_layer_count,
    cache_values,
    make_filled_cache,
    make_real_hybrid_cache,
    set_cache_keys,
)


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
    assert cache_layer_count(merged) == 1
    assert cache_value_layer_count(merged) == 1
    assert cache_values(merged) is not None


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
    original_shape = cache_keys(item.memory).shape

    # In-place mutation must not leak either: verify storage independence
    # before replacing the list slot with generation's appended tensor.
    merged_keys = cache_keys(merged)
    merged_keys.fill_(99.0)
    assert not torch.all(cache_keys(item.memory) == 99.0), "get_cache shares storage with store"
    merged_keys.zero_()

    # Simulate generation appending to the handed-out cache.
    appended = torch.ones((*merged_keys.shape[:-2], 1, merged_keys.shape[-1]))
    set_cache_keys(merged, torch.cat([merged_keys, appended], dim=-2))
    assert cache_keys(item.memory).shape == original_shape


def test_get_cache_multi_item_merge_does_not_alias_inputs(kv_memory):
    item1 = KVCacheItem(memory=make_filled_cache())
    item2 = KVCacheItem(memory=make_filled_cache())
    kv_memory.add([item1, item2])

    merged = kv_memory.get_cache([item1.id, item2.id])
    assert merged is not item1.memory
    assert merged is not item2.memory


def test_clone_dynamic_cache_copies_legacy_tensors():
    cache = make_filled_cache()
    original_shape = cache_keys(cache).shape
    cloned = clone_dynamic_cache(cache)

    assert cloned is not cache
    assert cache_keys(cloned) is not cache_keys(cache)
    assert torch.equal(cache_keys(cloned), cache_keys(cache))

    # In-place mutation must not leak either: verify storage independence
    # before replacing the list slot.
    cloned_keys = cache_keys(cloned)
    cloned_keys.fill_(99.0)
    assert not torch.all(cache_keys(cache) == 99.0), "clone shares storage with original"
    cloned_keys.zero_()

    replacement = torch.ones((*cloned_keys.shape[:-2], 5, cloned_keys.shape[-1]))
    set_cache_keys(cloned, replacement)
    assert cache_keys(cache).shape == original_shape


def test_clone_dynamic_cache_preserves_legacy_cache_state():
    cache = make_filled_cache()
    if not hasattr(cache, "key_cache"):
        pytest.skip("_seen_tokens is legacy DynamicCache state")
    cache._seen_tokens = 2

    cloned = clone_dynamic_cache(cache)

    assert cloned._seen_tokens == 2
    cloned.update(torch.ones(1, 1, 3), torch.ones(1, 1, 3), layer_idx=0)
    assert cloned._seen_tokens == 3
    assert cache._seen_tokens == 2


@pytest.mark.skipif(
    hasattr(DynamicCache(), "layers"), reason="requires the legacy DynamicCache API"
)
def test_clone_dynamic_cache_copies_legacy_tensor_state():
    cache = make_filled_cache()
    cache._cos_cached = torch.arange(3)

    cloned = clone_dynamic_cache(cache)

    assert torch.equal(cloned._cos_cached, cache._cos_cached)
    assert cloned._cos_cached is not cache._cos_cached
    cloned._cos_cached[0] = 99
    assert cache._cos_cached[0] == 0


def test_clone_dynamic_cache_rejects_mismatched_legacy_layers():
    class LegacyCache:
        def __init__(self):
            self.key_cache = [torch.zeros(1, 2, 3)]
            self.value_cache = []

    cache = LegacyCache()

    with pytest.raises(ValueError):
        clone_dynamic_cache(cache)


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

    # In-place mutation must not leak either: verify storage independence
    # before replacing the layer attribute.
    cloned.layers[0].keys.fill_(99.0)
    assert not torch.all(cache.layers[0].keys == 99.0), "clone shares tensor storage with original"
    cloned.layers[0].keys.zero_()

    cloned.layers[0].keys = torch.ones(2, 2, 3)
    assert cache.layers[0].keys.shape == (1, 2, 3)


def test_clone_dynamic_cache_preserves_real_hybrid_layers():
    cache = make_real_hybrid_cache()

    cloned = clone_dynamic_cache(cache)

    assert [type(layer) for layer in cloned.layers] == [type(layer) for layer in cache.layers]
    assert cloned.layers[1].sliding_window == 4
    assert cloned.layers[1].cumulative_length == cache.layers[1].cumulative_length
    assert torch.equal(cloned.layers[0].keys, cache.layers[0].keys)
    assert torch.equal(cloned.layers[1].values, cache.layers[1].values)
    assert cloned.layers[1].keys is not cache.layers[1].keys

    cloned.layers[1].update(torch.ones(1, 2, 1, 4), torch.ones(1, 2, 1, 4))
    assert cloned.layers[1].cumulative_length == 4
    assert cloned.layers[1].keys.shape[-2] == 3
    assert cache.layers[1].keys.shape[-2] == 3
    assert cache.layers[1].cumulative_length == 3


def test_clone_dynamic_cache_preserves_uninitialized_real_hybrid_layers():
    cache = make_real_hybrid_cache(populate=False)

    cloned = clone_dynamic_cache(cache)

    assert [type(layer) for layer in cloned.layers] == [type(layer) for layer in cache.layers]
    assert cloned.layers[0].keys is None
    assert cloned.layers[0].values is None
    assert cloned.layers[1].keys is None
    assert cloned.layers[1].values is None
    assert cloned.layers[1].sliding_window == cache.layers[1].sliding_window


def test_clone_dynamic_cache_layers_guard_keys_and_values_independently():
    # A layer may legitimately have only one side populated; the clone must
    # not crash on the missing side nor fabricate a value for it.
    class FakeLayer:
        def __init__(self):
            self.keys = None
            self.values = None

    class FakeLayeredCache:
        pass

    cache = FakeLayeredCache()
    keys_only = FakeLayer()
    keys_only.keys = torch.zeros(1, 2, 3)
    values_only = FakeLayer()
    values_only.values = torch.zeros(1, 2, 4)
    cache.layers = [keys_only, values_only]

    cloned = clone_dynamic_cache(cache)
    assert torch.equal(cloned.layers[0].keys, keys_only.keys)
    assert cloned.layers[0].values is None
    assert cloned.layers[1].keys is None
    assert torch.equal(cloned.layers[1].values, values_only.values)


def test_clone_dynamic_cache_handles_per_layer_key_value_cache():
    # Some transformers versions carry per-layer key_cache/value_cache
    # instead of keys/values (mirrors move_dynamic_cache_htod); the clone
    # must copy those tensors too instead of returning an empty layer.
    class FakeLayer:
        pass

    class FakeLayeredCache:
        pass

    cache = FakeLayeredCache()
    layer = FakeLayer()
    layer.key_cache = torch.zeros(1, 2, 3)
    layer.value_cache = torch.zeros(1, 2, 3)
    cache.layers = [layer]

    cloned = clone_dynamic_cache(cache)
    assert torch.equal(cloned.layers[0].key_cache, layer.key_cache)
    assert torch.equal(cloned.layers[0].value_cache, layer.value_cache)

    cloned.layers[0].key_cache.fill_(99.0)
    assert not torch.all(layer.key_cache == 99.0), "clone shares tensor storage with original"
    cloned.layers[0].value_cache.fill_(99.0)
    assert not torch.all(layer.value_cache == 99.0), (
        "clone shares value_cache tensor storage with original"
    )


def test_clone_dynamic_cache_preserves_layer_state():
    # DynamicLayer.update() uses these flags to decide whether to append to or
    # replace the existing history on its first update.
    class StatefulLayer:
        def __init__(self):
            self.is_initialized = False
            self._seen_tokens = 0
            self.keys = None
            self.values = None

        def update(self, keys, values):
            if self.is_initialized:
                self.keys = torch.cat([self.keys, keys], dim=-2)
                self.values = torch.cat([self.values, values], dim=-2)
            else:
                self.keys = keys
                self.values = values
                self.is_initialized = True
            self._seen_tokens += keys.shape[-2]

    class FakeLayeredCache:
        pass

    cache = FakeLayeredCache()
    layer = StatefulLayer()
    layer.keys = torch.zeros(1, 2, 3)
    layer.values = torch.zeros(1, 2, 3)
    layer.is_initialized = True
    layer._seen_tokens = 2
    cache.layers = [layer]

    cloned = clone_dynamic_cache(cache)

    assert cloned.layers[0].is_initialized is True
    assert cloned.layers[0]._seen_tokens == 2
    cloned.layers[0].update(torch.ones(1, 1, 3), torch.ones(1, 1, 3))
    assert cloned.layers[0].keys.shape == (1, 3, 3)
    assert cloned.layers[0].values.shape == (1, 3, 3)


def test_clone_dynamic_cache_copies_mutable_layer_state():
    class FakeLayer:
        def __init__(self):
            self.keys = None
            self.values = None
            self.metadata = {"history": ["original"]}

    class FakeLayeredCache:
        pass

    cache = FakeLayeredCache()
    cache.layers = [FakeLayer()]

    cloned = clone_dynamic_cache(cache)
    cloned.layers[0].metadata["history"].append("clone")

    assert cloned.layers[0].metadata == {"history": ["original", "clone"]}
    assert cache.layers[0].metadata == {"history": ["original"]}
    assert cloned.layers[0].metadata is not cache.layers[0].metadata
    assert cloned.layers[0].metadata["history"] is not cache.layers[0].metadata["history"]


def test_clone_dynamic_cache_rejects_unknown_shape():
    class UnknownCache:
        pass

    with pytest.raises(TypeError, match="neither 'layers' nor 'key_cache'"):
        clone_dynamic_cache(UnknownCache())


def test_clone_dynamic_cache_prefers_per_layer_cache_attributes():
    # A layer exposing both naming schemes must follow the same precedence as
    # move_dynamic_cache_htod: key_cache/value_cache take priority over keys/values.
    class FakeLayer:
        def __init__(self):
            self.keys = None
            self.values = None
            self.key_cache = None
            self.value_cache = None

    class FakeLayeredCache:
        pass

    cache = FakeLayeredCache()
    layer = FakeLayer()
    layer.keys = torch.zeros(1, 2, 3)
    layer.values = torch.zeros(1, 2, 3)
    layer.key_cache = torch.ones(1, 2, 3)
    layer.value_cache = torch.ones(1, 2, 3)
    cache.layers = [layer]

    cloned = clone_dynamic_cache(cache)

    assert torch.equal(cloned.layers[0].key_cache, layer.key_cache)
    assert torch.equal(cloned.layers[0].value_cache, layer.value_cache)
    assert cloned.layers[0].keys is None
    assert cloned.layers[0].values is None
