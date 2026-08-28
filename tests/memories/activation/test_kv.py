import logging
import os
import pickle

from unittest.mock import MagicMock

import pytest
import torch

from transformers import DynamicCache

from memos.configs.memory import KVCacheMemoryConfig
from memos.memories.activation.item import KVCacheItem
from memos.memories.activation.kv import KVCacheMemory


# ------------------------------------------------------------------ fixtures --


@pytest.fixture
def dummy_config():
    config = MagicMock(spec=KVCacheMemoryConfig)
    config.extractor_llm = MagicMock()
    config.memory_filename = "test_kv_cache.pkl"
    return config


def _make_fake_llm(
    *,
    model_name="test/writer",
    config_fp="cfg-A",
    tokenizer_fp="tok-A",
    torch_dtype="torch.float32",
    quantization=None,
    architectures=("LlamaForCausalLM",),
    num_hidden_layers=2,
    num_kv_heads=4,
    head_dim=8,
):
    """Build a MagicMock LLM whose _compute_producer_fingerprint output is
    controllable by the test.

    We take advantage of the fingerprint helper reading .config /
    .model.config / .tokenizer.backend_tokenizer — the helper is deliberately
    defensive so a MagicMock with the right shape suffices.
    """
    llm = MagicMock()
    llm.config.model_name_or_path = model_name
    llm.config.__class__.__name__ = "HFLLMConfig"

    # model.config.to_diff_dict() → drives config_fingerprint
    llm.model.config.to_diff_dict.return_value = {"marker": config_fp}
    llm.model.config.quantization_config = quantization
    llm.model.config.architectures = list(architectures)
    llm.model.config.num_hidden_layers = num_hidden_layers
    llm.model.config.num_key_value_heads = num_kv_heads
    llm.model.config.num_attention_heads = num_kv_heads
    llm.model.config.head_dim = head_dim
    llm.model.dtype = torch_dtype

    # tokenizer.backend_tokenizer.to_str() → drives tokenizer_fingerprint
    llm.tokenizer.backend_tokenizer.to_str.return_value = tokenizer_fp

    # build_kv_cache should return a real DynamicCache so pickle round-trips
    llm.build_kv_cache = MagicMock(return_value=DynamicCache())
    return llm


@pytest.fixture
def kv_memory_factory(dummy_config, monkeypatch):
    """Build KVCacheMemory instances with an injected fake LLM per test."""
    from memos.llms import factory as llm_factory

    def _factory(llm=None):
        llm = llm or _make_fake_llm()
        monkeypatch.setattr(llm_factory.LLMFactory, "from_config", lambda cfg: llm)
        return KVCacheMemory(dummy_config), llm

    return _factory


# ------------------------------------------------------------------ helpers --


def _make_populated_cache():
    """Return a DynamicCache with one layer, using the new-API .update path."""
    cache = DynamicCache()
    keys = torch.zeros(1, 2, 3, 4)
    values = torch.zeros(1, 2, 3, 4)
    cache.update(keys, values, 0)
    return cache


def _dump_and_load(kv, tmpdir):
    kv.dump(str(tmpdir))
    kv.kv_cache_memories = {}
    kv.load(str(tmpdir))
    return kv


# -------------------------------------------------------------------- tests --


class TestProducerFingerprintCapture:
    def test_extract_attaches_producer_metadata(self, kv_memory_factory):
        kv, _ = kv_memory_factory()
        item = kv.extract("hello world")
        assert "producer" in item.metadata
        producer = item.metadata["producer"]
        # required minimums
        assert producer["model_name_or_path"] == "test/writer"
        assert producer["backend"] == "HFLLMConfig"
        assert producer["config_fingerprint"] is not None
        assert producer["tokenizer_fingerprint"] is not None
        assert producer["torch_dtype"] == "torch.float32"

    def test_from_textual_memory_attaches_producer(self, kv_memory_factory):
        kv, _ = kv_memory_factory()

        class DummyTextual:
            memory = "foo"
            metadata = MagicMock(model_dump=lambda: {"bar": 1})

        item = kv.from_textual_memory(DummyTextual())
        assert item.metadata["bar"] == 1
        assert "producer" in item.metadata
        assert item.metadata["producer"]["model_name_or_path"] == "test/writer"

    def test_extract_survives_broken_fingerprint_source(self, kv_memory_factory):
        # A backend that cannot expose model.config still produces an item —
        # extract() must not raise even when introspection fails partially.
        llm = _make_fake_llm()
        llm.model.config.to_diff_dict.side_effect = RuntimeError("boom")
        kv, _ = kv_memory_factory(llm=llm)
        item = kv.extract("robust")
        assert isinstance(item, KVCacheItem)
        # producer still present, with at least model_name_or_path
        assert item.metadata["producer"]["model_name_or_path"] == "test/writer"
        # config_fingerprint is None because introspection failed
        assert item.metadata["producer"].get("config_fingerprint") is None


class TestProducerMismatchOnLoad:
    def test_match_installs_item_silently(self, kv_memory_factory, tmp_path, caplog):
        kv, _ = kv_memory_factory()
        item = kv.extract("prompt")
        kv.add([item])
        with caplog.at_level(logging.WARNING, logger="memos"):
            _dump_and_load(kv, tmp_path)
        # item still present
        assert item.id in kv.kv_cache_memories
        # nothing angry logged
        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert not errors

    def test_config_mismatch_drops_item_and_logs_error(self, kv_memory_factory, tmp_path, caplog):
        writer = _make_fake_llm(config_fp="writer-cfg")
        kv, _ = kv_memory_factory(llm=writer)
        item = kv.extract("prompt")
        kv.add([item])
        kv.dump(str(tmp_path))

        # Simulate a fresh process with a different model loaded.
        reader = _make_fake_llm(config_fp="reader-cfg")
        kv2, _ = kv_memory_factory(llm=reader)
        with caplog.at_level(logging.ERROR, logger="memos"):
            kv2.load(str(tmp_path))
        assert kv2.kv_cache_memories == {}
        error_lines = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
        assert any("config_fingerprint" in msg for msg in error_lines)
        assert any(item.id in msg for msg in error_lines)

    def test_tokenizer_mismatch_drops_item(self, kv_memory_factory, tmp_path, caplog):
        writer = _make_fake_llm(tokenizer_fp="writer-tok")
        kv, _ = kv_memory_factory(llm=writer)
        item = kv.extract("prompt")
        kv.add([item])
        kv.dump(str(tmp_path))

        reader = _make_fake_llm(tokenizer_fp="reader-tok")
        kv2, _ = kv_memory_factory(llm=reader)
        with caplog.at_level(logging.ERROR, logger="memos"):
            kv2.load(str(tmp_path))
        assert kv2.kv_cache_memories == {}

    def test_dtype_mismatch_drops_item(self, kv_memory_factory, tmp_path, caplog):
        writer = _make_fake_llm(torch_dtype="torch.float32")
        kv, _ = kv_memory_factory(llm=writer)
        item = kv.extract("prompt")
        kv.add([item])
        kv.dump(str(tmp_path))

        reader = _make_fake_llm(torch_dtype="torch.bfloat16")
        kv2, _ = kv_memory_factory(llm=reader)
        with caplog.at_level(logging.ERROR, logger="memos"):
            kv2.load(str(tmp_path))
        assert kv2.kv_cache_memories == {}

    def test_missing_producer_key_installs_with_warning(self, kv_memory_factory, tmp_path, caplog):
        # Simulate a pre-fix cache: manually write an item without a
        # producer key. Loader must warn but keep the item (deprecation
        # window semantics).
        kv, _ = kv_memory_factory()
        legacy_item = KVCacheItem(
            memory=DynamicCache(),
            metadata={"source_text": "legacy", "extracted_at": "old"},
        )
        payload = {"kv_cache_memories": {legacy_item.id: legacy_item}}
        os.makedirs(tmp_path, exist_ok=True)
        with open(os.path.join(tmp_path, kv.config.memory_filename), "wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)

        with caplog.at_level(logging.WARNING, logger="memos"):
            kv.load(str(tmp_path))
        assert legacy_item.id in kv.kv_cache_memories
        assert any(
            "no producer" in r.getMessage().lower()
            for r in caplog.records
            if r.levelno == logging.WARNING
        )

    def test_mixed_batch_only_good_items_installed(self, kv_memory_factory, tmp_path, caplog):
        writer = _make_fake_llm(config_fp="writer-cfg")
        kv, _ = kv_memory_factory(llm=writer)
        good = kv.extract("stays")
        bad = kv.extract("drops")
        # Corrupt one producer to force a mismatch on load
        bad.metadata["producer"]["config_fingerprint"] = "mismatch"
        kv.add([good, bad])
        kv.dump(str(tmp_path))

        reader = _make_fake_llm(config_fp="writer-cfg")
        kv2, _ = kv_memory_factory(llm=reader)
        with caplog.at_level(logging.ERROR, logger="memos"):
            kv2.load(str(tmp_path))
        assert good.id in kv2.kv_cache_memories
        assert bad.id not in kv2.kv_cache_memories


class TestCorruptCacheLogging:
    def test_corrupt_pickle_logs_warning_and_resets(self, kv_memory_factory, tmp_path, caplog):
        kv, _ = kv_memory_factory()
        file_path = tmp_path / kv.config.memory_filename
        # Write a garbage byte stream that will fail to unpickle
        file_path.write_bytes(b"\x00\x01not-a-pickle-file")

        with caplog.at_level(logging.WARNING, logger="memos"):
            kv.load(str(tmp_path))
        assert kv.kv_cache_memories == {}
        assert any(
            "kv cache" in r.getMessage().lower() or "load" in r.getMessage().lower()
            for r in caplog.records
            if r.levelno == logging.WARNING
        )


# ------------------------------------------ smoke tests for previously-passing --


def test_extract_and_add_and_get(kv_memory_factory):
    kv, _ = kv_memory_factory()
    item = kv.extract("hello world")
    assert isinstance(item, KVCacheItem)
    assert isinstance(item.memory, DynamicCache)
    kv.add([item])
    assert kv.get(item.id) is item


def test_get_cache_merge(kv_memory_factory):
    kv, _ = kv_memory_factory()
    item1 = KVCacheItem(memory=_make_populated_cache())
    item2 = KVCacheItem(memory=_make_populated_cache())
    kv.add([item1, item2])
    merged = kv.get_cache([item1.id, item2.id])
    assert isinstance(merged, DynamicCache)
    assert len(merged.layers) == 1


def test_delete_and_get_all(kv_memory_factory):
    kv, _ = kv_memory_factory()
    item = KVCacheItem(memory=_make_populated_cache())
    kv.add([item])
    assert item in kv.get_all()
    kv.delete([item.id])
    assert kv.get(item.id) is None
    kv.add([item])
    kv.delete_all()
    assert kv.get_all() == []


def test_from_textual_memory(kv_memory_factory):
    kv, _ = kv_memory_factory()

    class DummyTextualMemory:
        memory = "foo"
        metadata = MagicMock(model_dump=lambda: {"bar": 1})

    item = kv.from_textual_memory(DummyTextualMemory())
    assert isinstance(item, KVCacheItem)
    assert item.metadata["bar"] == 1
