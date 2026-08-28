import logging
import os
import pickle

from unittest.mock import MagicMock

import pytest

from memos.configs.memory import KVCacheMemoryConfig
from memos.memories.activation.item import VLLMKVCacheItem
from memos.memories.activation.vllmkv import VLLMKVCacheMemory


@pytest.fixture
def dummy_config():
    config = MagicMock(spec=KVCacheMemoryConfig)
    config.extractor_llm = MagicMock()
    config.memory_filename = "test_vllm_kv_cache.pkl"
    return config


def _make_fake_vllm(model_name="test/vllm-writer", tokenizer_fp="tok-A"):
    llm = MagicMock()
    llm.config.model_name_or_path = model_name
    llm.config.__class__.__name__ = "VLLMLLMConfig"
    # vLLM backend often has no local model, but may have a tokenizer via HF.
    llm.model = None
    llm.tokenizer.backend_tokenizer.to_str.return_value = tokenizer_fp
    llm.build_vllm_kv_cache = MagicMock(side_effect=lambda t: f"prompt::{t}")
    return llm


@pytest.fixture
def vllm_memory_factory(dummy_config, monkeypatch):
    from memos.llms import factory as llm_factory

    def _factory(llm=None):
        llm = llm or _make_fake_vllm()
        monkeypatch.setattr(llm_factory.LLMFactory, "from_config", lambda cfg: llm)
        return VLLMKVCacheMemory(dummy_config), llm

    return _factory


class TestVLLMProducerFingerprint:
    def test_extract_attaches_producer(self, vllm_memory_factory):
        kv, _ = vllm_memory_factory()
        item = kv.extract("hello")
        assert "producer" in item.metadata
        producer = item.metadata["producer"]
        assert producer["model_name_or_path"] == "test/vllm-writer"
        assert producer["backend"] == "VLLMLLMConfig"
        # vLLM has no HF model → config_fingerprint is None; that's fine
        assert producer["config_fingerprint"] is None
        assert producer["tokenizer_fingerprint"] is not None

    def test_tokenizer_mismatch_drops_item(self, vllm_memory_factory, tmp_path, caplog):
        writer = _make_fake_vllm(tokenizer_fp="writer-tok")
        kv, _ = vllm_memory_factory(llm=writer)
        item = kv.extract("prompt")
        kv.add([item])
        kv.dump(str(tmp_path))

        reader = _make_fake_vllm(tokenizer_fp="reader-tok")
        kv2, _ = vllm_memory_factory(llm=reader)
        with caplog.at_level(logging.ERROR, logger="memos"):
            kv2.load(str(tmp_path))
        assert kv2.kv_cache_memories == {}

    def test_missing_producer_installs_with_warning(self, vllm_memory_factory, tmp_path, caplog):
        kv, _ = vllm_memory_factory()
        legacy = VLLMKVCacheItem(
            memory="legacy-prompt",
            metadata={"source_text": "old", "extracted_at": "old"},
        )
        payload = {"kv_cache_memories": {legacy.id: legacy}}
        os.makedirs(tmp_path, exist_ok=True)
        with open(os.path.join(tmp_path, kv.config.memory_filename), "wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)

        with caplog.at_level(logging.WARNING, logger="memos"):
            kv.load(str(tmp_path))
        assert legacy.id in kv.kv_cache_memories
        assert any(
            "no producer" in r.getMessage().lower()
            for r in caplog.records
            if r.levelno == logging.WARNING
        )

    def test_corrupt_pickle_logs_warning(self, vllm_memory_factory, tmp_path, caplog):
        kv, _ = vllm_memory_factory()
        file_path = tmp_path / kv.config.memory_filename
        file_path.write_bytes(b"\x00garbage")
        with caplog.at_level(logging.WARNING, logger="memos"):
            kv.load(str(tmp_path))
        assert kv.kv_cache_memories == {}
        assert any(
            r.levelno == logging.WARNING and "load" in r.getMessage().lower()
            for r in caplog.records
        )
