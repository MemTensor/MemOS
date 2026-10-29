from unittest.mock import MagicMock

import pytest

from transformers import DynamicCache

from memos.configs.memory import KVCacheMemoryConfig
from memos.memories.activation.item import KVCacheItem
from memos.memories.activation.kv import KVCacheMemory, clone_dynamic_cache
from tests.utils import (
    dynamic_cache_key_tensors,
    dynamic_cache_layer_count,
    dynamic_cache_seq_len,
    make_dynamic_cache,
)


# The KV cache is a torch structure; skip the whole module where torch is
# not installed instead of failing the collection of the test suite.
torch = pytest.importorskip("torch")


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
    return make_dynamic_cache(seq_len=3)


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
    # Check the number of layers in merged cache
    assert dynamic_cache_layer_count(merged) == 1


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


def test_clone_dynamic_cache_does_not_share_tensors():
    # A clone must not share any tensor with the original: transformers appends
    # the generated tokens to the cache object in place.
    cache = make_filled_cache()
    cloned = clone_dynamic_cache(cache)

    assert cloned is not cache
    assert dynamic_cache_layer_count(cloned) == dynamic_cache_layer_count(cache)

    original_keys = dynamic_cache_key_tensors(cache)[0]
    cloned_keys = dynamic_cache_key_tensors(cloned)[0]
    assert cloned_keys is not original_keys
    assert cloned_keys.data_ptr() != original_keys.data_ptr()
    assert torch.equal(cloned_keys, original_keys)

    # The copy still reports the same number of cached tokens, i.e. the layer
    # state (such as the initialization flag) survives the copy.
    assert cloned.get_seq_length() == cache.get_seq_length()

    # Appending to the clone (what a model does) leaves the original untouched.
    cloned.update(torch.zeros(1, 2, 1, 4), torch.ones(1, 2, 1, 4), 0)
    assert dynamic_cache_seq_len(cloned) == 4
    assert dynamic_cache_seq_len(cache) == 3
    assert cloned.get_seq_length() == 4
    assert cache.get_seq_length() == 3


def test_get_cache_single_item_returns_independent_copy(kv_memory):
    # The stored cache must never be handed out: the model appends the
    # generated tokens to the cache it receives, in place.
    item = KVCacheItem(memory=make_filled_cache())
    kv_memory.add([item])

    cached = kv_memory.get_cache([item.id])

    assert cached is not None
    assert cached is not item.memory
    assert dynamic_cache_seq_len(cached) == 3

    cached.update(torch.zeros(1, 2, 1, 4), torch.ones(1, 2, 1, 4), 0)

    assert dynamic_cache_seq_len(cached) == 4
    assert dynamic_cache_seq_len(item.memory) == 3


def test_clone_dynamic_cache_handles_empty_cache():
    # An empty cache has to be copied into an independent empty cache: the
    # model appends its first layer to the cache it receives, and that append
    # must not reach the stored cache.
    cache = DynamicCache()
    cloned = clone_dynamic_cache(cache)

    assert cloned is not cache
    assert dynamic_cache_layer_count(cloned) == 0
    assert dynamic_cache_layer_count(cache) == 0

    cloned.update(torch.zeros(1, 2, 1, 4), torch.ones(1, 2, 1, 4), 0)

    assert dynamic_cache_layer_count(cloned) == 1
    assert dynamic_cache_layer_count(cache) == 0
    assert cache.get_seq_length() == 0


def test_get_cache_merge_does_not_alias_inputs(kv_memory):
    # Merging concatenates the inputs into new tensors; the stored caches
    # stay untouched.
    item1 = KVCacheItem(memory=make_filled_cache())
    item2 = KVCacheItem(memory=make_filled_cache())
    kv_memory.add([item1, item2])

    merged = kv_memory.get_cache([item1.id, item2.id])

    assert merged is not None
    assert dynamic_cache_layer_count(merged) == 1
    # Two caches of 3 tokens each are merged into a single 6-token layer.
    assert dynamic_cache_seq_len(merged) == 6

    merged.update(torch.zeros(1, 2, 1, 4), torch.ones(1, 2, 1, 4), 0)

    assert dynamic_cache_seq_len(item1.memory) == 3
    assert dynamic_cache_seq_len(item2.memory) == 3


def test_clone_dynamic_cache_handles_legacy_layout():
    # transformers < 4.55 keeps the tensors in the flat "key_cache" and
    # "value_cache" lists instead of per-layer objects.
    class LegacyCache:
        def __init__(self):
            self.key_cache = [torch.zeros(1, 2, 3, 4)]
            self.value_cache = [torch.ones(1, 2, 3, 4)]

    cache = LegacyCache()
    cloned = clone_dynamic_cache(cache)

    assert cloned is not cache
    assert cloned.key_cache[0] is not cache.key_cache[0]
    assert cloned.key_cache[0].data_ptr() != cache.key_cache[0].data_ptr()
    assert torch.equal(cloned.key_cache[0], cache.key_cache[0])
    assert cloned.value_cache[0].data_ptr() != cache.value_cache[0].data_ptr()
    assert torch.equal(cloned.value_cache[0], cache.value_cache[0])


def test_clone_dynamic_cache_prefers_the_layers_layout():
    # A cache that exposes the modern "layers" layout next to the legacy
    # "key_cache"/"value_cache" aliases must be copied through the modern
    # layout: the model appends its layers to "layers", so that list must not
    # be shared with the original.
    class CacheWithLegacyAliases:
        def __init__(self):
            self.layers = []
            self.key_cache = []
            self.value_cache = []

        def update(self, key_states, value_states, layer_idx):
            self.layers.append(layer_idx)

    cache = CacheWithLegacyAliases()
    cloned = clone_dynamic_cache(cache)

    assert cloned is not cache
    assert cloned.layers is not cache.layers

    cloned.update(None, None, 0)

    assert cache.layers == []


def test_clone_dynamic_cache_copies_layers_with_legacy_attribute_names():
    # Some transformers versions expose "key_cache"/"value_cache" on the layer
    # objects instead of "keys"/"values"; both variants have to be copied.
    class LegacyLayer:
        def __init__(self):
            self.key_cache = torch.zeros(1, 2, 3, 4)
            self.value_cache = torch.ones(1, 2, 3, 4)

    class LayeredCache:
        def __init__(self):
            self.layers = [LegacyLayer()]

    cache = LayeredCache()
    cloned = clone_dynamic_cache(cache)

    assert cloned is not cache
    assert cloned.layers[0] is not cache.layers[0]
    assert cloned.layers[0].key_cache.data_ptr() != cache.layers[0].key_cache.data_ptr()
    assert torch.equal(cloned.layers[0].key_cache, cache.layers[0].key_cache)
    assert cloned.layers[0].value_cache.data_ptr() != cache.layers[0].value_cache.data_ptr()
    assert torch.equal(cloned.layers[0].value_cache, cache.layers[0].value_cache)
