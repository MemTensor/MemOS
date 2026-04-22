import json

from transformers import DynamicCache

from memos.configs.memory import MemoryConfigFactory
from memos.memories.activation.item import KVCacheItem
from memos.memories.factory import MemoryFactory


def get_cache_info(cache):
    if not cache:
        return None

    num_layers = 0
    total_size_bytes = 0

    if hasattr(cache, "layers"):
        num_layers = len(cache.layers)
        for layer in cache.layers:
            if hasattr(layer, "key_cache") and layer.key_cache is not None:
                total_size_bytes += layer.key_cache.nelement() * layer.key_cache.element_size()
            if hasattr(layer, "value_cache") and layer.value_cache is not None:
                total_size_bytes += layer.value_cache.nelement() * layer.value_cache.element_size()

            if hasattr(layer, "keys") and layer.keys is not None:
                total_size_bytes += layer.keys.nelement() * layer.keys.element_size()
            if hasattr(layer, "values") and layer.values is not None:
                total_size_bytes += layer.values.nelement() * layer.values.element_size()

    elif hasattr(cache, "key_cache") and hasattr(cache, "value_cache"):
        num_layers = len(cache.key_cache)
        for k, v in zip(cache.key_cache, cache.value_cache, strict=False):
            if k is not None:
                total_size_bytes += k.nelement() * k.element_size()
            if v is not None:
                total_size_bytes += v.nelement() * v.element_size()

    return {
        "num_layers": num_layers,
        "size_bytes": total_size_bytes,
        "size_mb": f"{total_size_bytes / (1024 * 1024):.2f} MB",
    }


def serialize_item(obj):
    if isinstance(obj, list):
        return [serialize_item(x) for x in obj]

    if isinstance(obj, KVCacheItem):
        return {
            "id": obj.id,
            "metadata": obj.metadata,
            "records": obj.records.model_dump()
            if hasattr(obj.records, "model_dump")
            else obj.records,
            "memory": get_cache_info(obj.memory),
        }

    if isinstance(obj, DynamicCache):
        return get_cache_info(obj)

    return str(obj)


if __name__ == "__main__":
    # ===== Example: Use factory and HFLLM to build and manage KVCacheMemory =====

    # 1. Create config for KVCacheMemory (using HuggingFace backend)
    config = MemoryConfigFactory(
        backend="kv_cache",
        config={
            "extractor_llm": {
                "backend": "huggingface",
                "config": {
                    "model_name_or_path": "Qwen/Qwen3-0.6B",  # Use a valid HuggingFace model name
                    "max_tokens": 32,
                    "add_generation_prompt": True,
                    "remove_think_prefix": True,
                },
            },
        },
    )

    # 2. Instantiate KVCacheMemory using the factory
    kv_mem = MemoryFactory.from_config(config)

    # 3. Extract a KVCacheItem (DynamicCache) from a prompt (uses HFLLM.build_kv_cache internally)
    prompt = [
        {"role": "user", "content": "What is MemOS?"},
        {"role": "assistant", "content": "MemOS is a memory operating system for LLMs."},
    ]
    print("===== Extract KVCacheItem =====")
    cache_item = kv_mem.extract(prompt)
    print(json.dumps(serialize_item(cache_item), indent=2, default=str))
    print()

    # 4. Add the extracted KVCacheItem
    print("===== Add KVCacheItem =====")
    kv_mem.add([cache_item])
    print(json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str))
    print()

    # 5. Get by id
    print("===== Get KVCacheItem by id =====")
    retrieved = kv_mem.get(cache_item.id)
    print(json.dumps(serialize_item(retrieved), indent=2, default=str))
    print()

    # 6. Merge caches (simulate with two items)
    print("===== Merge DynamicCache =====")
    item2 = kv_mem.extract([{"role": "user", "content": "Tell me a joke."}])
    kv_mem.add([item2])
    merged_cache = kv_mem.get_cache([cache_item.id, item2.id])
    print(json.dumps(serialize_item(merged_cache), indent=2, default=str))
    print()

    # 7. Delete one
    print("===== Delete one KVCacheItem =====")
    kv_mem.delete([cache_item.id])
    print(json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str))
    print()

    # 8. Dump and load
    print("===== Dump and Load KVCacheMemory =====")
    kv_mem.dump("tmp/kv_mem")
    print("Memory dumped to 'tmp/kv_mem'.")
    kv_mem.delete_all()
    kv_mem.load("tmp/kv_mem")
    print(
        "Memory loaded from 'tmp/kv_mem':",
        json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str),
    )
