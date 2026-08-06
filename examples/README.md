# MemOS Examples

This directory contains runnable examples for MemOS modules, memory types, API
usage, and integrations. Run examples from the repository root so relative
configuration and data paths resolve correctly.

## Running Examples

Install the project dependencies first, then run a script directly:

```bash
python examples/mem_cube/load_cube.py
```

Some examples require extra services or credentials, such as Neo4j, Redis,
model provider API keys, or local model backends. Check the script and matching
documentation before running those examples.

For guided walkthroughs, see the [examples guide](../docs/en/open_source/getting_started/examples.md)
and the module documentation under [docs/en/open_source/modules](../docs/en/open_source/modules).

## Directory Overview

| Directory | Purpose |
| --- | --- |
| `api` | Server router and product API usage examples. |
| `basic_modules` | Focused examples for embedders, LLMs, chunkers, rerankers, graph databases, and textual memory helpers. |
| `core_memories` | Examples for core memory backends such as general, naive, preference, tree textual, KV cache, and vLLM KV cache memory. |
| `data` | Shared sample configs, memory cube data, and input assets used by other examples. |
| `dream` | End-to-end dream pipeline example. |
| `extras` | Additional standalone demos that do not fit the main module categories. |
| `mem_agent` | Agent-oriented examples, including deep search usage. |
| `mem_chat` | Chat examples that combine generated cubes and explicit memory. |
| `mem_cube` | MemCube load, dump, and legacy remote or lazy loading examples. |
| `mem_feedback` | Examples for memory feedback workflows. |
| `mem_mcp` | FastMCP server and client examples for MemOS integrations. |
| `mem_reader` | MemReader parser, builder, sample, and runner demos for text, files, images, and messages. |
| `mem_scheduler` | Scheduler examples for Redis-backed asynchronous memory workflows. |

