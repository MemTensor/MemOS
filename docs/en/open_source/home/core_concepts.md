---
title: Core Concepts
desc: MemOS treats memory as a first-class citizen. Its core design revolves around how to orchestrate, store, retrieve, and govern memory for your LLM applications.
---

## Overview

* [MOS (Memory Operating System)](#mos-memory-operating-system)
* [MemCube](#️memcube)
* [Memory Types](#memory-types)
* [Cross-Cutting Concepts](#cross-cutting-concepts)


## MOS (Memory Operating System)

**What it is:**
The orchestration layer that coordinates multiple MemCubes and memory operations. It connects your LLMs with structured, explainable memory for reasoning and planning.

**When to use:**
Use MOS whenever you need to bridge users, sessions, or agents with consistent, auditable memory workflows.

## MemCube

**What it is:**
A MemCube is like a flexible, swappable memory cartridge. Each user, session, or task can have its own MemCube, which can hold one or more memory types.

**When to use:**
Use different MemCubes to isolate, reuse, or scale your memory as your system grows.

## Memory Types

MemOS treats memory like a living system — not just static data but evolving knowledge. Here's how the three core memory types work together:

| Memory Type    | Description                                  | When to Use                                 |
|----------------|----------------------------------------------|---------------------------------------------|
| **Parametric** | Knowledge distilled into model weights        | Evergreen skills, stable domain expertise   |
| **Activation** | Short-term KV cache and hidden states         | Fast reuse in dialogue, multi-turn sessions |
| **Plaintext**  | Text, docs, graph nodes, or vector chunks     | Searchable, inspectable, evolving knowledge |

### Parametric Memory

**What:**
Knowledge embedded directly into the model's weights — think of this as the model's "cortex". It's always on, providing zero-latency reasoning.

**When to use:**
Perfect for stable domain knowledge, distilled FAQs, or skills that rarely change.

### Activation Memory

**What:**
Activation Memory is your model's reusable "working memory" — it includes precomputed key-value caches and hidden states that can be directly injected into the model's attention mechanism.
Think of it as pre-cooked context that saves your LLM from repeatedly
re-encoding static or frequently used information.

**Why it matters:**
By storing stable background content (like FAQs or known facts) in a KV-cache, your model can skip redundant computation during the prefill phase.
This dramatically reduces Time To First Token (TTFT) and improves throughput for multi-turn conversations or retrieval-augmented generation.

**When to use:**
- Reuse background knowledge across many user queries.
- Speed up chatbots that rely on the same domain context each turn.
- Combine with MemScheduler to auto-promote stable plaintext memory to KV format.

### Explicit Memory

**What:**
Structured or unstructured knowledge units — user-visible, explainable. These can be documents, chat logs, graph nodes, or vector embeddings.

**When to use:**
Best for semantic search, user preferences, or traceable facts that evolve over time. Supports tags, provenance, and lifecycle states.


## How They Work Together

MemOS lets you orchestrate all three memory types in a living loop:

- Hot plaintext memories can be distilled into parametric weights.
- High-frequency activation paths become reusable KV templates.
- Stale parametric or activation units can be downgraded to plaintext nodes for traceability.

With MemOS, your AI doesn't just store facts — it **remembers**, **understands**, and **grows**.

::note
**Insight**<br>
  Over time, frequently used plaintext memories can be distilled into parametric form.
  Rarely used weights or caches can be demoted to plaintext storage for auditing and retraining.
::

## Cross-Cutting Concepts

### Hybrid Retrieval

Combines vector similarity and graph traversal for robust, context-aware search.

### Governance & Lifecycle

Every memory unit supports states (active, merged, archived), provenance tracking, and fine-grained access control — essential for auditing and compliance.

::note
**Compliance Reminder**<br>
Always track provenance and state changes for each memory unit.
  This helps meet audit and data governance requirements.
::

## Key Takeaway

With MemOS, your LLM applications gain structured, evolving memory — empowering agents to plan, reason, and adapt like never before.
