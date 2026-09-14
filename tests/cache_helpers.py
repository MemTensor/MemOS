import pytest
import torch

from transformers import DynamicCache


def make_filled_cache():
    cache = DynamicCache()
    keys = torch.zeros(1, 2, 3, 4) if hasattr(cache, "layers") else torch.zeros(1, 2, 3)
    values = torch.zeros_like(keys)
    cache.update(keys, values, layer_idx=0)
    return cache


def cache_keys(cache, layer_idx=0):
    if hasattr(cache, "layers"):
        return cache.layers[layer_idx].keys
    return cache.key_cache[layer_idx]


def cache_values(cache, layer_idx=0):
    if hasattr(cache, "layers"):
        return cache.layers[layer_idx].values
    return cache.value_cache[layer_idx]


def set_cache_keys(cache, value, layer_idx=0):
    if hasattr(cache, "layers"):
        cache.layers[layer_idx].keys = value
    else:
        cache.key_cache[layer_idx] = value


def cache_layer_count(cache):
    if hasattr(cache, "layers"):
        return len(cache.layers)
    return len(cache.key_cache)


def cache_value_layer_count(cache):
    if hasattr(cache, "layers"):
        return len(cache.layers)
    return len(cache.value_cache)


def make_real_hybrid_cache(populate=True):
    if not hasattr(DynamicCache(), "layers"):
        pytest.skip("requires transformers >=4.56")

    class HybridConfig:
        num_hidden_layers = 2
        sliding_window = 4

        def __init__(self):
            self.layer_types = ["full_attention", "sliding_attention"]

        def get_text_config(self):
            return self

    try:
        cache = DynamicCache(config=HybridConfig())
    except TypeError:
        pytest.skip("DynamicCache(config=...) is not supported")
    if populate:
        keys = torch.zeros(1, 2, 3, 4)
        values = torch.zeros(1, 2, 3, 4)
        cache.update(keys, values, layer_idx=0)
        cache.update(keys, values, layer_idx=1)
    return cache
