---
title: Architecture
desc: MemOS is made up of **core modules** that work together to turn your LLM into a truly **memory-augmented system** — from orchestration to storage to retrieval.
---

## Core Modules

### MOS (Memory Operating System)

The orchestration layer of MemOS — it
  manages predictive, asynchronous scheduling across multiple memory types (plaintext, activation, parametric) and orchestrates **multi-user, multi-session** memory workflows.

MOS connects memory containers (**MemCubes**) with LLMs via a unified API for adding, searching, updating, transferring, or rolling back memories. It also supports cross-model, cross-device interoperability through a unified Memory Interchange Protocol (MIP).

### MemCube
A modular, portable **memory container** — think of it like a flexible cartridge that can hold one or more memory types for a **user, agent, or session**.

MemCubes can be dynamically registered, updated, or removed. They support containerized storage that is transferable across sessions, models, and devices.

### Memories

  MemOS supports several specialized memory types for different needs:

#### 1. **Parametric Memory**(**Coming Soon**)

Embedded in model weights;
    long-term,
    high-efficiency, but hard to edit.

#### 2. **Activation Memory**

Runtime hidden states & KV-cache; short-term,
transient, steering dynamic behavior.

#### 3. Plaintext Memory

Structured or unstructured knowledge
blocks; editable, traceable, suitable for fast updates, personalization & multi-agent sharing.

- **GeneralTextMemory:** Flexible, vector-based storage for unstructured
textual knowledge with semantic search and metadata filtering.
- **TreeTextMemory:** Hierarchical, graph-style memory for structured
knowledge — combining **tree-based hierarchy** and **cross-branch linking** for dynamic, evolving knowledge graphs. It supports long-term organization and multi-hop reasoning (often Neo4j-backed).

::note
**Best Practice**<br>
Start simple with <code>GeneralTextMemory</code> — then scale to graph or KV-cache as your needs grow.
::

#### Basic Modules

Includes chunkers, embedders, LLM connectors, parsers, and interfaces for vector/graph databases. These provide the building blocks for memory extraction, semantic embedding, storage, and retrieval.

## Code Structure

MemOS project is organized for clarity and plug-and-play:

```
src/memos/
    api/           # API definitions
    chunkers/      # Text chunking utilities
    configs/       # Configuration schemas
    context/       # Log context
    embedders/     # Embedding models
    graph_dbs/     # Graph database backends (e.g., Neo4j)
    vec_dbs/       # Vector database backends (e.g., Qdrant)
    llms/          # LLM connectors
    mem_agent/     # Deep search
    mem_chat/      # Memory-augmented chat logic
    mem_cube/      # MemCube management
    mem_feedback   # Memory feedback
    mem_os/        # MOS orchestration
    mem_reader/    # Memory readers
    mem_scheduler/ # Memory scheduling module
    memories/      # Memory type implementations
    multi_mem_cube/# Multi-view Cube
    parsers/       # Parsing utilities
    reranker/      # Reranker module
    templates/     # Prompt templates
    types/         # Type definitions
```

::note
**Pro Tip**<br>
Use <code>examples/</code> for quick experimentation and <code>docs/</code> for module deep dives.
::

## Extensibility

MemOS is **modular by design**.
Add your own memory types, storage backends, or LLM connectors with minimal changes — thanks to its **unified config and factory patterns**.


::note
**Pro Tip**<br>
[Contribute](/open_source/contribution/overview) a new backend or share your custom memory
type — it’s easy to plug in.
::
