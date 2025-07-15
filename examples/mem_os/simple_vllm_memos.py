#!/usr/bin/env python3
"""
Simple example demonstrating how to use VLLMLLM with an existing vLLM server.
Requires a vLLM server to be running.
"""

from typing import TYPE_CHECKING

from memos.configs.llm import VLLMLLMConfig
from memos.llms.vllm import VLLMLLM


if TYPE_CHECKING:
    from memos.types import MessageDict


def main():
    """Main function demonstrating VLLMLLM usage."""

    # Configuration for connecting to existing vLLM server
    config = VLLMLLMConfig(
        model_name_or_path="/mnt/afs/models/hf_models/Qwen2.5-7B",  # MUST MATCH the --model arg of vLLM server
        api_key="",  # Not needed for local server
        api_base="http://localhost:8088/v1",  # vLLM server address with /v1
        temperature=0.7,
        max_tokens=512,
        top_p=0.9,
        model_schema="memos.configs.llm.VLLMLLMConfig",
    )

    # Initialize VLLM LLM
    print("Initializing VLLM LLM...")
    llm = VLLMLLM(config)

    # Test messages for KV cache building
    print("\nBuilding KV cache for system messages...")
    system_messages: list[MessageDict] = [
        {"role": "system", "content": "You are a helpful AI assistant."},
        {"role": "user", "content": "Hello! Can you tell me about vLLM?"},
    ]
    try:
        prompt = llm.build_vllm_kv_cache(system_messages)
        print(f"✓ KV cache built successfully for prompt: '{prompt[:100]}...'")
    except Exception as e:
        print(f"✗ Failed to build KV cache: {e}")

    # Test with different messages for generation
    print("\nGenerating response...")
    user_messages: list[MessageDict] = [
        {"role": "system", "content": "You are a helpful AI assistant. Please Introduce yourself "},
        {"role": "user", "content": "What are the benefits of using vLLM?"},
    ]
    try:
        response = llm.generate(user_messages)
        print(f"Response: {response}")
    except Exception as e:
        print(f"Error generating response: {e}")


if __name__ == "__main__":
    main()
