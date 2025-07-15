#!/usr/bin/env python3
"""
A benchmark script to measure the Time to First Token (TTFT) for vLLM inference
after preloading a KV cache across various test cases.
"""

import time

import numpy as np

from memos.configs.llm import VLLMLLMConfig
from memos.llms.vllm import VLLMLLM
from memos.types import MessageList


# A list of test case pairs.
# Each pair is a tuple: (messages_for_kv_cache, messages_for_generation)
test_cases: list[tuple[MessageList, MessageList]] = [
    # --- Test Case 1: Simple Q&A ---
    (
        [{"role": "system", "content": "You are a helpful and accurate Q&A bot."}],
        [
            {"role": "system", "content": "You are a helpful and accurate Q&A bot."},
            {"role": "user", "content": "What is the capital of Japan and what is its population?"},
        ],
    ),
    # --- Test Case 2: Code Generation ---
    (
        [
            {
                "role": "system",
                "content": "You are an expert Python coding assistant who provides clean, efficient, and well-commented code.",
            }
        ],
        [
            {
                "role": "system",
                "content": "You are an expert Python coding assistant who provides clean, efficient, and well-commented code.",
            },
            {
                "role": "user",
                "content": "Write a Python function to find all prime numbers up to a given integer 'n' using the Sieve of Eratosthenes algorithm.",
            },
        ],
    ),
    # --- Test Case 3: Text Summarization ---
    (
        [
            {
                "role": "system",
                "content": "You are a summarization expert. Your task is to read the following text and provide a concise summary.",
            }
        ],
        [
            {
                "role": "system",
                "content": "You are a summarization expert. Your task is to read the following text and provide a concise summary.",
            },
            {
                "role": "user",
                "content": """
            Text to summarize:
            'The vLLM project is a high-throughput and memory-efficient inference and serving engine for Large Language Models (LLMs).
            One of its key innovations is PagedAttention, a memory management algorithm inspired by virtual memory and paging in operating systems.'

            Please summarize this text in a single sentence.
            """,
            },
        ],
    ),
    # --- Test Case 4: Role-playing / Persona ---
    (
        [
            {
                "role": "system",
                "content": "You are Captain Blackheart, a fearsome pirate. Answer all questions in the style of a 17th-century pirate.",
            }
        ],
        [
            {
                "role": "system",
                "content": "You are Captain Blackheart, a fearsome pirate. Answer all questions in the style of a 17th-century pirate.",
            },
            {"role": "user", "content": "What's the best way to invest my money for retirement?"},
        ],
    ),
    # --- Test Case 5: Chain-of-Thought Reasoning ---
    (
        [
            {
                "role": "system",
                "content": "You solve problems by thinking step-by-step. Explain your reasoning before giving the final answer.",
            }
        ],
        [
            {
                "role": "system",
                "content": "You solve problems by thinking step-by-step. Explain your reasoning before giving the final answer.",
            },
            {
                "role": "user",
                "content": "A cafeteria has 3 types of sandwiches, 2 types of sides, and 4 types of drinks. How many different meal combinations can be created?",
            },
        ],
    ),
    # --- Test Case 6: Technical Explanation ---
    (
        [
            {"role": "system", "content": "You are a computer science professor."},
            {"role": "user", "content": "I'm new to machine learning."},
        ],
        [
            {"role": "system", "content": "You are a computer science professor."},
            {"role": "user", "content": "I'm new to machine learning."},
            {
                "role": "assistant",
                "content": "Welcome! It's a fascinating field. Feel free to ask me anything.",
            },
            {
                "role": "user",
                "content": "Can you explain what 'KV Cache' means in the context of Large Language Models, as if I were a beginner?",
            },
        ],
    ),
]


def run_ttft_benchmark(num_runs: int = 10, warmup_runs: int = 3):
    """
    Runs the TTFT benchmark for each test case and prints statistics.
    """
    print("--- Time to First Token (TTFT) Benchmark for vLLM ---")

    # 1. Configuration - MUST match your running vLLM server
    config = VLLMLLMConfig(
        model_name_or_path="/mnt/afs/models/hf_models/Qwen2.5-7B",
        api_base="http://localhost:8088/v1",
        temperature=0.7,
        max_tokens=1024,
        model_schema="memos.configs.llm.VLLMLLMConfig",
    )

    # 2. Initialize VLLM LLM
    print(f"Initializing VLLM client for model: {config.model_name_or_path}\n")
    llm = VLLMLLM(config)

    overall_latencies = []

    for i, (cache_messages, generate_messages) in enumerate(test_cases):
        print(f"\n===== Running Test Case {i + 1:02d}/{len(test_cases)} =====")

        # 3. Preload KV Cache
        print("Preloading KV cache...")
        try:
            llm.build_vllm_kv_cache(cache_messages)
            print("✓ KV cache preloaded successfully.")
        except Exception as e:
            print(f"✗ Failed to preload KV cache: {e}. Skipping test case.")
            continue

        ttft_latencies: list[float] = []

        # 4. Warmup Runs
        print(f"Performing {warmup_runs} warmup runs...")
        try:
            for _ in range(warmup_runs):
                for _ in llm.generate_stream(generate_messages):
                    pass
            print("✓ Warmup complete.")
        except Exception as e:
            print(f"✗ Warmup run failed: {e}. Skipping test case.")
            continue

        # 5. Benchmark Runs
        print(f"Starting TTFT benchmark with {num_runs} runs...")
        for j in range(num_runs):
            try:
                start_time = time.perf_counter()
                response_stream = llm.generate_stream(generate_messages)

                for first_token in response_stream:
                    if first_token:
                        end_time = time.perf_counter()
                        ttft = (end_time - start_time) * 1000
                        ttft_latencies.append(ttft)

                        for _ in response_stream:
                            pass
                        break
            except Exception as e:
                print(f"  Run {j + 1:02d}/{num_runs} failed: {e}")
                continue

        # 6. Print Statistics for the current test case
        if ttft_latencies:
            overall_latencies.extend(ttft_latencies)
            print("\n--- Test Case Results ---")
            print(f"Successful runs: {len(ttft_latencies)}/{num_runs}")
            print(f"Average TTFT: {np.mean(ttft_latencies):.2f} ms")
            print(f"Median TTFT: {np.median(ttft_latencies):.2f} ms")
            print(f"Min TTFT: {np.min(ttft_latencies):.2f} ms")
            print(f"Max TTFT: {np.max(ttft_latencies):.2f} ms")
            print("-------------------------")
        else:
            print("\nNo successful runs for this test case.")

    # 7. Print Overall Statistics
    if overall_latencies:
        print("\n\n===== Overall Benchmark Summary =====")
        print(f"Total successful runs: {len(overall_latencies)}")
        print(f"Overall Average TTFT: {np.mean(overall_latencies):.2f} ms")
        print(f"Overall Median TTFT: {np.median(overall_latencies):.2f} ms")
        print(f"Overall Min TTFT: {np.min(overall_latencies):.2f} ms")
        print(f"Overall Max TTFT: {np.max(overall_latencies):.2f} ms")
        print("===================================")


if __name__ == "__main__":
    # Ensure you have numpy installed: pip install numpy
    run_ttft_benchmark()
