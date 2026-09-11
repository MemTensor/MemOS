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


# --------------------------------------------------------------------------
# RoPE re-rotation on merge
# --------------------------------------------------------------------------

def _rope_reference(k_raw, positions, inv_freq):
    """Rotate raw keys to absolute `positions` using transformers' own kernel.

    Grounding the test against the library's implementation rather than a second
    copy of our own arithmetic -- otherwise the test only proves we are
    self-consistent.
    """
    from transformers.models.qwen2.modeling_qwen2 import apply_rotary_pos_emb

    ang = positions[:, None].float() * inv_freq[None, :].float()
    ang = torch.cat([ang, ang], dim=-1)
    cos, sin = ang.cos()[None], ang.sin()[None]
    kt = k_raw[None, None]
    _, out = apply_rotary_pos_emb(kt, kt, cos, sin)
    return out[0, 0]


def test_merge_rerotates_second_fragment_to_its_new_position(kv_memory):
    """A merged fragment must carry the phase of where it LANDS, not where it was built.

    transformers rotates keys before writing them to the cache, so a cached key
    for token i of a fragment encodes absolute position i *of that fragment*.
    Concatenating fragment 2 behind fragment 1 moves its keys to slots
    L1..L1+L2-1 while their phase still says 0..L2-1.

    This builds two fragments the way the model would, merges them, and compares
    against keys rotated directly at the positions they end up occupying, using
    transformers' own ``apply_rotary_pos_emb`` as the reference.

    Scope: this checks POSITIONAL PHASE only. Merging fragments remains an
    approximation of a single cache regardless, because each fragment's hidden
    states were computed without the others in context -- but that is a separate
    and much smaller error than a wholesale phase mismatch.
    """
    from unittest.mock import MagicMock

    torch.manual_seed(0)
    head_dim, n_heads, l1, l2 = 8, 2, 5, 4
    inv_freq = 1_000_000.0 ** (-torch.arange(0, head_dim, 2).float() / head_dim)

    k_raw_1 = torch.randn(n_heads, l1, head_dim)
    k_raw_2 = torch.randn(n_heads, l2, head_dim)

    # what each fragment stores: rotated at ITS OWN positions, from 0
    frag1 = _rope_reference(k_raw_1, torch.arange(l1), inv_freq)[None]
    frag2 = _rope_reference(k_raw_2, torch.arange(l2), inv_freq)[None]

    # what a correct merge must produce: fragment 2 rotated at l1..l1+l2-1
    want = torch.cat(
        [
            _rope_reference(k_raw_1, torch.arange(l1), inv_freq)[None],
            _rope_reference(k_raw_2, torch.arange(l1, l1 + l2), inv_freq)[None],
        ],
        dim=-2,
    )

    c1, c2 = DynamicCache(), DynamicCache()
    c1.update(frag1, torch.zeros_like(frag1), 0)
    c2.update(frag2, torch.zeros_like(frag2), 0)

    # a model stub exposing only what the merge needs
    rotary = MagicMock()
    rotary.inv_freq = inv_freq
    rotary.rope_type = "default"
    model = MagicMock()
    model.model.rotary_emb = rotary
    kv_memory.llm.model = model

    merged = kv_memory._concat_caches([c1, c2])
    got = merged.layers[0].keys if hasattr(merged, "layers") else merged.key_cache[0]

    err = (got.float() - want.float()).abs().max().item()
    assert err < 1e-4, (
        f"merged keys differ from keys rotated at their landing positions by "
        f"{err:.3e}; fragment 2 is carrying the phase of positions 0..{l2 - 1} "
        f"instead of {l1}..{l1 + l2 - 1}"
    )


def test_merge_refuses_to_rerotate_non_composing_rope(kv_memory, caplog):
    """A rope schedule that recomputes with length must not be silently re-rotated.

    Dynamic/NTK schedules change the frequencies as the sequence grows, so
    R(a) then R(b) != R(a+b) and a delta rotation would be wrong in a *different*
    way. Skip and say so, rather than guessing.
    """
    from unittest.mock import MagicMock

    rotary = MagicMock()
    rotary.inv_freq = torch.ones(4)
    rotary.rope_type = "dynamic"
    model = MagicMock()
    model.model.rotary_emb = rotary
    kv_memory.llm.model = model

    c1, c2 = make_filled_cache(seq_len=3), make_filled_cache(seq_len=2)
    with caplog.at_level(logging.WARNING, logger="memos.memories.activation.kv"):
        merged = kv_memory._concat_caches([c1, c2])

    # Assert on the tensor, not get_seq_length(): on transformers >= 4.57 a merged
    # cache reports 0 regardless, which is a separate bug fixed on its own branch.
    got = merged.layers[0].keys if hasattr(merged, "layers") else merged.key_cache[0]
    assert got.shape[-2] == 5, "the fragments should still be concatenated"
    assert any("does not compose" in r.getMessage() for r in caplog.records), (
        f"no warning about the non-composing schedule; got "
        f"{[r.getMessage() for r in caplog.records]}"
    )
