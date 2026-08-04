"""Regression tests for the restricted-unpickler hardening in
``KVCacheMemory.load`` and ``VLLMKVCacheMemory.load``.

Issue #2203: raw ``pickle.load`` on the activation-cache file is an RCE
sink. These tests craft pickle streams whose ``__reduce__`` names a
disallowed class (``os.system``) and assert the unpickler rejects them
without executing the payload.
"""

from __future__ import annotations

import os
import pickle

from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest


if TYPE_CHECKING:
    from pathlib import Path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _OsSystemPayload:
    """__reduce__ returns (os.system, ("touch <canary>",)).  Loading this
    via a raw ``pickle.load`` writes the canary; loading via SafeUnpickler
    must raise before ``os.system`` is invoked."""

    def __init__(self, canary_path: str) -> None:
        self.canary_path = canary_path

    def __reduce__(self):  # type: ignore[override]
        return (os.system, (f"touch {self.canary_path}",))


def _write_hostile_pickle(target: Path, canary_path: str) -> None:
    with open(target, "wb") as f:
        pickle.dump(_OsSystemPayload(canary_path), f)


# ---------------------------------------------------------------------------
# kv.py — KVCacheMemory
# ---------------------------------------------------------------------------


@pytest.fixture
def kv_memory(monkeypatch):
    from memos.configs.memory import KVCacheMemoryConfig
    from memos.llms import factory as llm_factory
    from memos.memories.activation.kv import KVCacheMemory

    monkeypatch.setattr(
        llm_factory.LLMFactory,
        "from_config",
        lambda cfg: MagicMock(build_kv_cache=lambda x: None),
    )
    config = MagicMock(spec=KVCacheMemoryConfig)
    config.extractor_llm = MagicMock()
    config.memory_filename = "kv_cache.pkl"
    return KVCacheMemory(config)


def test_kv_load_refuses_hostile_pickle(tmp_path: Path, kv_memory) -> None:
    """os.system-based __reduce__ must be rejected; canary must not exist."""
    canary = tmp_path / "kv_canary"
    _write_hostile_pickle(tmp_path / kv_memory.config.memory_filename, str(canary))

    kv_memory.load(str(tmp_path))

    assert not canary.exists(), "SafeUnpickler failed to block os.system payload"
    assert kv_memory.kv_cache_memories == {}


def test_kv_load_refuses_arbitrary_class(tmp_path: Path, kv_memory) -> None:
    """A pickle referencing a random not-allowlisted class must be rejected."""
    import io

    from memos.memories.activation.kv import _SafeUnpickler  # noqa: F401

    # Pickle referencing `subprocess.Popen` via a bare name; we don't
    # actually instantiate — the find_class hook must reject at load time.
    raw = pickle.dumps({"kv_cache_memories": []}, protocol=pickle.HIGHEST_PROTOCOL)
    # sanity: with allowlist this legit pickle must load
    from memos.memories.activation.kv import _SafeUnpickler as SafeUnpickler

    obj = SafeUnpickler(io.BytesIO(raw)).load()
    assert isinstance(obj, dict)
    assert obj["kv_cache_memories"] == []

    # now craft one that names subprocess.Popen — must raise
    stream = pickle.dumps(_OsSystemPayload("/tmp/should_not_run"), protocol=pickle.HIGHEST_PROTOCOL)
    with pytest.raises(pickle.UnpicklingError):
        SafeUnpickler(io.BytesIO(stream)).load()


def test_kv_load_round_trip_dump(tmp_path: Path, kv_memory) -> None:
    """A legitimate pickle produced by dump() must load fine."""
    from transformers import DynamicCache

    from memos.memories.activation.item import KVCacheItem

    # No dynamic cache tensors — DynamicCache() empty is picklable
    item = KVCacheItem(memory=DynamicCache(), metadata={"note": "hi"})
    kv_memory.add([item])
    kv_memory.dump(str(tmp_path))

    # Fresh instance
    kv_memory.kv_cache_memories = {}
    kv_memory.load(str(tmp_path))
    assert item.id in kv_memory.kv_cache_memories


# ---------------------------------------------------------------------------
# vllmkv.py — VLLMKVCacheMemory
# ---------------------------------------------------------------------------


@pytest.fixture
def vllm_memory(monkeypatch):
    from memos.configs.memory import KVCacheMemoryConfig
    from memos.llms import factory as llm_factory
    from memos.memories.activation.vllmkv import VLLMKVCacheMemory

    monkeypatch.setattr(
        llm_factory.LLMFactory,
        "from_config",
        lambda cfg: MagicMock(build_vllm_kv_cache=lambda x: "prompt"),
    )
    config = MagicMock(spec=KVCacheMemoryConfig)
    config.extractor_llm = MagicMock()
    config.memory_filename = "vllm_kv_cache.pkl"
    return VLLMKVCacheMemory(config)


def test_vllm_load_refuses_hostile_pickle(tmp_path: Path, vllm_memory) -> None:
    canary = tmp_path / "vllm_canary"
    _write_hostile_pickle(tmp_path / vllm_memory.config.memory_filename, str(canary))

    vllm_memory.load(str(tmp_path))

    assert not canary.exists(), "SafeUnpickler failed to block os.system payload"
    assert vllm_memory.kv_cache_memories == {}


def test_vllm_load_round_trip_dump(tmp_path: Path, vllm_memory) -> None:
    """A legitimate pickle produced by dump() must load fine."""
    from memos.memories.activation.item import VLLMKVCacheItem

    item = VLLMKVCacheItem(memory="a prompt", metadata={"note": "hi"})
    vllm_memory.add([item])
    vllm_memory.dump(str(tmp_path))

    vllm_memory.kv_cache_memories = {}
    vllm_memory.load(str(tmp_path))
    assert item.id in vllm_memory.kv_cache_memories
