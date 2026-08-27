import logging

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


def test_dump_records_model_identity(kv_memory, tmp_path):
    """A dumped cache must record which model produced it."""
    kv_memory.config.extractor_llm.model_name_or_path = "org/model-a"
    kv_memory.add([KVCacheItem(memory=make_filled_cache())])
    kv_memory.dump(str(tmp_path))

    import pickle

    with open(tmp_path / kv_memory.config.memory_filename, "rb") as f:
        data = pickle.load(f)
    assert data.get("model_identity") == {"model_name_or_path": "org/model-a"}


def test_load_warns_on_model_mismatch(kv_memory, tmp_path, caplog):
    """Loading a cache built by different weights must not be silent.

    A KV cache is the internal activations of one specific set of weights. Loaded
    into a different model it is accepted without error and simply shifts the
    next-token distribution -- measured KL 0.08-0.92 with top-1 flips on 2 of 5
    probes for a close fine-tune pair. Before this change nothing was recorded
    and nothing was checked, so the mismatch was undetectable.
    """
    kv_memory.config.extractor_llm.model_name_or_path = "org/model-a"
    kv_memory.add([KVCacheItem(memory=make_filled_cache())])
    kv_memory.dump(str(tmp_path))

    # same store, different weights
    kv_memory.config.extractor_llm.model_name_or_path = "org/model-b"
    with caplog.at_level(logging.WARNING, logger="memos.memories.activation.kv"):
        kv_memory.load(str(tmp_path))

    # getMessage() applies the lazy %-args; record.message only exists after a
    # formatter has run, which is not guaranteed under caplog.
    messages = [r.getMessage() for r in caplog.records]
    assert any("org/model-a" in m and "org/model-b" in m for m in messages), (
        f"no mismatch warning naming both models; got {messages}"
    )


def test_load_is_quiet_when_model_matches(kv_memory, tmp_path, caplog):
    """No warning when the cache is loaded under the weights that built it."""
    kv_memory.config.extractor_llm.model_name_or_path = "org/model-a"
    kv_memory.add([KVCacheItem(memory=make_filled_cache())])
    kv_memory.dump(str(tmp_path))
    with caplog.at_level(logging.WARNING, logger="memos.memories.activation.kv"):
        kv_memory.load(str(tmp_path))
    assert not [r for r in caplog.records if "was built with model" in r.getMessage()]
