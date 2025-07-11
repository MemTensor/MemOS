#!/usr/bin/env python3
"""
Simple example demonstrating how to use VLLMLLM with existing vLLM server.
Requires a vLLM server to be running on localhost:8088.
"""

import asyncio
import sys

from memos.configs.llm import VLLMLLMConfig
from memos.llms.vllm import VLLMLLM
from memos.types import MessageList


def main():
    """Main function demonstrating VLLMLLM usage."""
    
    # Configuration for connecting to existing vLLM server
    config = VLLMLLMConfig(
        model_name_or_path="Qwen/Qwen3-1.7B",  # Model name (for reference)
        api_key="",  # Not needed for local server
        api_base="http://localhost:8088",  # vLLM server address
        temperature=0.7,
        max_tokens=512,
        top_p=0.9,
        top_k=50,
        model_schema="memos.configs.llm.VLLMLLMConfig",
    )
    
    # Initialize VLLM LLM
    print("Initializing VLLM LLM...")
    llm = VLLMLLM(config)
    
    # Test messages for KV cache building
    system_messages: MessageList = [
        {"role": "system", "content": "You are a helpful AI assistant."},
        {"role": "user", "content": "Hello! Can you tell me about vLLM?"}
    ]
    
    # Build KV cache for system messages
    print("Building KV cache for system messages...")
    try:
        prompt = llm.build_vllm_kv_cache(system_messages)
        print(f"✓ KV cache built successfully. Prompt length: {len(prompt)}")
    except Exception as e:
        print(f"✗ Failed to build KV cache: {e}")
    
    # Test with different messages
    user_messages: MessageList = [
        {"role": "system", "content": "You are a helpful AI assistant."},
        {"role": "user", "content": "What are the benefits of using vLLM?"}
    ]
    
    # Generate response
    print("\nGenerating response...")
    try:
        response = llm.generate(user_messages)
        print(f"Response: {response}")
    except Exception as e:
        print(f"Error generating response: {e}")
    
    # Test with string input for KV cache
    print("\nTesting KV cache with string input...")
    try:
        string_prompt = llm.build_vllm_kv_cache("You are a helpful assistant.")
        print(f"✓ String KV cache built successfully. Prompt length: {len(string_prompt)}")
    except Exception as e:
        print(f"✗ Failed to build string KV cache: {e}")
    
    # Test with list of strings input for KV cache
    print("\nTesting KV cache with list of strings input...")
    try:
        list_prompt = llm.build_vllm_kv_cache(["You are helpful.", "You are knowledgeable."])
        print(f"✓ List KV cache built successfully. Prompt length: {len(list_prompt)}")
    except Exception as e:
        print(f"✗ Failed to build list KV cache: {e}")


if __name__ == "__main__":
    main() 