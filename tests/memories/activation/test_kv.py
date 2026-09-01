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


def make_filled_cache(seq_len: int = 3):
    """Build a DynamicCache with one populated layer.

    Works against both the current transformers layout (``layers`` list of
    ``DynamicLayer``) and the legacy layout (``key_cache`` /
    ``value_cache`` lists). Tensors are 4-D
    ``[batch, num_heads, seq_len, head_dim]`` as expected by
    ``DynamicLayer.update``.
    """
    cache = DynamicCache()
    keys = torch.zeros(1, 2, seq_len, 4)
    vals = torch.zeros(1, 2, seq_len, 4)
    if hasattr(cache, "layers"):
        # transformers >= 4.57: DynamicCache exposes `layers` and
        # `.update(...)` routes through DynamicLayer.lazy_initialization,
        # so `is_initialized` becomes True.
        cache.update(keys, vals, layer_idx=0)
    else:  # pragma: no cover - legacy path retained for older transformers
        cache.key_cache.append(keys)
        cache.value_cache.append(vals)
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
    # Check that the merged cache exposes at least one populated layer,
    # regardless of the transformers layout at runtime.
    if hasattr(merged, "layers"):
        assert len(merged.layers) == 1
        assert merged.layers[0].keys.numel() > 0
        assert merged.layers[0].values.numel() > 0
    else:  # pragma: no cover - legacy transformers layout
        assert len(merged.key_cache) == 1
        assert len(merged.value_cache) == 1


def test_concat_layer_reports_initialized_and_full_seq_length(kv_memory):
    """Regression for issue #2313.

    On transformers >= 4.57, DynamicLayer.get_seq_length() short-circuits to
    0 when `is_initialized` is False. `_concat_caches` used to build layers
    via bare `layer_cls()` + direct `.keys` / `.values` assignment, which
    bypasses `lazy_initialization` and leaves the flag False. The
    consequence: merged caches reported length 0, and the first forward
    pass silently discarded every merged token. This test asserts the
    invariants of that fix and fails on the pre-fix implementation.
    """
    seq_len = 5
    item1 = KVCacheItem(memory=make_filled_cache(seq_len=seq_len))
    item2 = KVCacheItem(memory=make_filled_cache(seq_len=seq_len))
    kv_memory.add([item1, item2])

    merged = kv_memory.get_cache([item1.id, item2.id])
    assert merged is not None

    # This path is only exercised on transformers >= 4.57. The bug lives
    # here — get_seq_length() must reflect the true merged length.
    if hasattr(merged, "layers"):
        assert merged.layers[0].keys.shape[-2] == 2 * seq_len
        assert merged.layers[0].values.shape[-2] == 2 * seq_len
        # `is_initialized` is set inside DynamicLayer.lazy_initialization —
        # bypassing that path is what triggered the silent data loss.
        assert getattr(merged.layers[0], "is_initialized", True) is True
        assert merged.get_seq_length() == 2 * seq_len


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
