#!/usr/bin/env python3
"""
Example demonstrating how to use VLLMKVCacheMemory with vLLM backend.
This example shows how to use the new vLLM-compatible KV cache memory.
"""

from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory


def main():
    """Main function demonstrating VLLMKVCacheMemory usage."""

    print("=== VLLM KV Cache Memory Example ===\n")

    # 1. Create config for VLLMKVCacheMemory (using vLLM backend)
    config = MemoryConfigFactory(
        backend="vllm_kv_cache",  # Use the new vLLM KV cache backend
        config={
            "extractor_llm": {
                "backend": "vllm",
                "config": {
                    "model_name_or_path": "/mnt/afs/models/hf_models/Qwen2.5-7B",
                    "api_base": "http://localhost:8088/v1",
                    "temperature": 0.7,
                    "max_tokens": 1024,
                    "model_schema": "memos.configs.llm.VLLMLLMConfig",
                },
            },
        },
    )

    # 2. Instantiate VLLMKVCacheMemory using the factory
    print("Initializing VLLM KV Cache Memory...")
    vllm_kv_mem = MemoryFactory.from_config(config)
    print("✓ VLLM KV Cache Memory initialized successfully.\n")

    # 3. Extract a VLLMKVCacheItem from a prompt
    print("===== Extract VLLMKVCacheItem =====")
    system_prompt = [
        {"role": "system", "content": "You are a helpful AI assistant."},
        {"role": "user", "content": "What is MemOS?"},
        {"role": "assistant", "content": "MemOS is a memory operating system for LLMs."},
    ]

    try:
        cache_item = vllm_kv_mem.extract(system_prompt)
        print("✓ KV cache item extracted successfully")
        print(f"  ID: {cache_item.id}")
        print(f"  Memory (prompt): {cache_item.memory[:100]}...")
        print(f"  Metadata: {cache_item.metadata}")
        print()
    except Exception as e:
        print(f"✗ Failed to extract KV cache item: {e}")
        return

    # 4. Add the extracted VLLMKVCacheItem
    print("===== Add VLLMKVCacheItem =====")
    vllm_kv_mem.add([cache_item])
    all_items = vllm_kv_mem.get_all()
    print(f"✓ Added cache item. Total items: {len(all_items)}")
    print()

    # 5. Get by id
    print("===== Get VLLMKVCacheItem by id =====")
    retrieved = vllm_kv_mem.get(cache_item.id)
    if retrieved:
        print(f"✓ Retrieved cache item: {retrieved.id}")
        print(f"  Memory (prompt): {retrieved.memory[:100]}...")
    else:
        print("✗ Failed to retrieve cache item")
    print()

    # 6. Get cache (returns prompt string for vLLM)
    print("===== Get Cache (Prompt String) =====")
    prompt_string = vllm_kv_mem.get_cache([cache_item.id])
    if prompt_string:
        print(f"✓ Retrieved prompt string: {prompt_string[:100]}...")
        print("  This prompt can be used for vLLM generation with preloaded KV cache")
    else:
        print("✗ Failed to retrieve prompt string")
    print()

    # 7. Extract another cache item for demonstration
    print("===== Extract Another VLLMKVCacheItem =====")
    another_prompt = [
        {"role": "system", "content": "You are a coding assistant."},
        {"role": "user", "content": "Write a Python function to calculate fibonacci numbers."},
    ]

    try:
        cache_item2 = vllm_kv_mem.extract(another_prompt)
        vllm_kv_mem.add([cache_item2])
        print(f"✓ Added second cache item. Total items: {len(vllm_kv_mem.get_all())}")
        print()
    except Exception as e:
        print(f"✗ Failed to extract second KV cache item: {e}")
        print()

    # 8. Preload KV cache on vLLM server
    print("===== Preload KV Cache on vLLM Server =====")
    try:
        vllm_kv_mem.preload_kv_cache([cache_item.id, cache_item2.id])
        print("✓ KV cache preloaded on vLLM server successfully")
        print("  The server now has the KV cache ready for fast generation")
    except Exception as e:
        print(f"✗ Failed to preload KV cache: {e}")
    print()

    # 9. Delete one item
    print("===== Delete One VLLMKVCacheItem =====")
    vllm_kv_mem.delete([cache_item.id])
    remaining_items = vllm_kv_mem.get_all()
    print(f"✓ Deleted cache item. Remaining items: {len(remaining_items)}")
    print()

    # 10. Dump and load
    print("===== Dump and Load VLLMKVCacheMemory =====")
    try:
        vllm_kv_mem.dump("tmp/vllm_kv_mem")
        print("✓ Memory dumped to 'tmp/vllm_kv_mem'")

        # Clear memory and reload
        vllm_kv_mem.delete_all()
        vllm_kv_mem.load("tmp/vllm_kv_mem")
        reloaded_items = vllm_kv_mem.get_all()
        print(f"✓ Memory loaded from 'tmp/vllm_kv_mem': {len(reloaded_items)} items")
    except Exception as e:
        print(f"✗ Failed to dump/load memory: {e}")
    print()

    print("=== Example completed successfully ===")


if __name__ == "__main__":
    main()
