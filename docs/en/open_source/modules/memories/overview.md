---
title: "Memory Modules Overview"
desc: "Complete guide to MemOS memory systems - from lightweight text memory to advanced graph structures, choose the right memory module for your needs"
---


The Memory Module provides Agents with essential long-term memory capabilities. Instead of acting as a static database, it mimics human cognitive processes by automatically extracting, organizing, and linking information. Choosing different memory modules allows you to customize and enhance your Agent's skills.

## 🎯 Quick Selection Guide

::alert{type="info"}
**Not sure which to choose?** Follow this decision tree:
- 🚀 **Quick testing/demo**: Get started easily with no additional software → [NaiveTextMemory](#naivetextmemory-simple-textual-memory)
- 📝 **General text memory**: Retain chat history or massive documents with semantic search capabilities → [GeneralTextMemory](#generaltextmemory-general-purpose-textual-memory)
- 👤 **User preference management**：Specifically designed for building and managing user profiles → [PreferenceTextMemory](#preferencetextmemory-preference-memory)
- 🌳 **Structured knowledge graph**: Ideal for data with complex logical relationships and interconnections → [TreeTextMemory](#treetextmemory-hierarchical-structured-memory)
- ⚡ **Inference acceleration**: Optimized for high-traffic scenarios to ensure stable and rapid responses → [KVCacheMemory](#kvcachememory-activation-memory)
::

---

## 📚 Memory Module Categories

### I. Textual Memory Series

Focused on storing and retrieving text-based memories, suitable for most application scenarios.

#### NaiveTextMemory: Simple Textual Memory
::card
**Use Cases:** Rapid prototyping, demos, teaching, small-scale applications

**Core Features:**
- ✅ Zero dependencies, pure in-memory storage
- ✅ Keyword-based retrieval
- ✅ Minimal API, get started in 5 minutes
- ✅ File persistence support

**Limitations:**
- ❌ No vector semantic search
- ❌ Not suitable for large-scale data
- ❌ Limited retrieval precision

📖 [View Documentation](./naive_textual_memory)
::

#### GeneralTextMemory: General-Purpose Textual Memory
::card
**Use Cases:** Conversational agents, personal assistants, knowledge management systems

**Core Features:**
- ✅ Vector-based semantic search
- ✅ Rich metadata support (type, time, source, etc.)
- ✅ Flexible filtering and querying
- ✅ Suitable for medium to large-scale applications

**Technical Requirements:**
- Requires vector database (Qdrant, etc.)
- Requires embedding model

📖 [View Documentation](./general_textual_memory)
::

#### PreferenceTextMemory: Preference Memory
::card
**Use Cases:** Personalized recommendations, user profiling, intelligent assistants

**Core Features:**
- ✅ Automatic detection of explicit and implicit preferences
- ✅ Preference deduplication and conflict detection
- ✅ Filter by preference type and strength
- ✅ Vector semantic retrieval

**Specialized Functions:**
- Dual preference extraction (explicit/implicit)
- Preference strength scoring
- Temporal decay support

📖 [View Documentation](./preference_textual_memory)
::

#### TreeTextMemory: Hierarchical Structured Memory
::card
**Use Cases:** Knowledge graphs, complex relationship reasoning, multi-hop queries

**Core Features:**
- ✅ Graph database-based structured storage
- ✅ Support for hierarchical relationships and causal chains
- ✅ Multi-hop reasoning capabilities
- ✅ Deduplication, conflict detection, memory scheduling

**Advanced Features:**
- Supports MultiModal Reader (images, URLs, files)
- Supports Internet Retrieval (BochaAI, Google, Bing)
- Working memory replacement mechanism

**Technical Requirements:**
- Requires graph database (Neo4j, etc.)
- Requires vector database and embedding model

📖 [View Documentation](./tree_textual_memory)
::

---

### II. Specialized Memory Modules

Memory systems optimized for specific scenarios.

#### KVCacheMemory: Activation Memory
::card
**Use Cases:** LLM inference acceleration, high-frequency background knowledge reuse

**Core Features:**
- ⚡ Pre-computed KV Cache, skip repeated encoding
- ⚡ Significantly reduce prefill phase computation
- ⚡ Suitable for high-throughput scenarios

**Typical Use Cases:**
- FAQ caching
- Conversation history reuse
- Domain knowledge preloading

**How It Works:**
Stable text memory → Pre-convert to KV Cache → Direct injection during inference

📖 [View Documentation](./kv_cache_memory)
::

#### ParametricMemory: Parametric Memory
::card
**Status:** 🚧 Under Development

**Design Goals:**
- Encode knowledge into model weights (LoRA, expert modules)
- Dynamically load/unload capability modules
- Support multi-task, multi-role architecture

**Future Features:**
- Parameter module generation and compression
- Version control and rollback
- Hot-swappable capability modules

📖 [View Documentation](./parametric_memory)
::

---

### III. Graph Database Backends

Provide graph storage capabilities for TreeTextMemory.

#### Neo4j Graph DB
::card
**Recommendation:** ⭐⭐⭐⭐⭐

**Features:**
- Complete graph database functionality
- Support for vector-enhanced retrieval
- Multi-tenant architecture (v0.2.1+)
- Compatible with Community Edition

📖 [View Documentation](./neo4j_graph_db)
::

#### Nebula Graph DB
::card
**Features:**
- Distributed graph database
- High availability
- Suitable for large-scale deployment

📖 [View Documentation](./nebula_graph_db)
::

#### PolarDB Graph DB
::card
**Features:**
- Alibaba Cloud PolarDB graph computing
- Cloud-native architecture
- Enterprise-grade reliability

📖 [View Documentation](./polardb_graph_db)
::

---

## 📊 Feature Comparison Table

| Feature | Naive | General | Preference | Tree | KVCache |
|---------|-------|---------|------------|------|---------|
| **Search Method** | Keyword | Vector Semantic | Vector Semantic | Vector+Graph | N/A |
| **Metadata Support** | ⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | - |
| **Relationship Reasoning** | ❌ | ❌ | ❌ | ✅ | - |
| **Deduplication** | ❌ | ⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | - |
| **Scalability** | Small | Medium-Large | Medium-Large | Large | - |
| **Deployment Complexity** | Minimal | Medium | Medium | Higher | Medium |
| **Inference Acceleration** | - | - | - | - | ⭐⭐⭐⭐⭐ |

---

## 🛠️ Usage Scenario Recommendations

### Scenario 1: Rapid Prototyping
**Recommended:** [NaiveTextMemory](./naive_textual_memory)
```python
from memos.memories import NaiveTextMemory
memory = NaiveTextMemory()
memory.add("User likes coffee")
results = memory.search("coffee")
```

### Scenario 2: Chatbot Memory
**Recommended:** [GeneralTextMemory](./general_textual_memory)
- Supports semantic search
- Filter by time, type, source
- Suitable for conversation history management

### Scenario 3: Personalized Recommendation System
**Recommended:** [PreferenceTextMemory](./preference_textual_memory)
- Automatic user preference extraction
- Preference conflict detection
- Strength scoring and filtering

### Scenario 4: Knowledge Graph Applications
**Recommended:** [TreeTextMemory](./tree_textual_memory)
- Multi-hop relationship queries
- Hierarchical structure management
- Complex reasoning scenarios

### Scenario 5: High-Performance LLM Services
**Recommended:** [KVCacheMemory](./kv_cache_memory)
- FAQ systems
- Customer service bots
- High-volume request processing

---

## 🔗 Advanced Features

### MultiModal Reader (Multimodal Reading)
Supported in TreeTextMemory for processing:
- 📷 Images in conversations
- 🌐 Web URLs
- 📄 Local files (PDF, DOCX, TXT, Markdown)
- 🔀 Mixed mode (text+images+URLs)

👉 [View Examples](./tree_textual_memory#using-multimodalstructmemreader-advanced)

### Internet Retrieval
Fetch real-time information from the web and add to memory:
- 🔍 BochaAI search
- 🌍 Google search
- 🔎 Bing search

👉 [View Examples](./tree_textual_memory#retrieve-memories-from-the-internet-optional)

---

## 🚀 Quick Start

1. **Choose Memory Module** - Select the appropriate module based on the guide above
2. **Read Documentation** - Click the corresponding link to view detailed documentation
3. **Hands-On Practice** - Each module has complete code examples
4. **Production Deployment** - Refer to the best practices section

---

## 📖 Related Resources

- [API Reference](/api)
- [Best Practices Guide](/best-practices)
- [Example Code Repository](https://github.com/MemOS/examples)
- [FAQ](/faq)

---

::alert{type="tip"}
**Beginner Suggestion:** Start with NaiveTextMemory, understand the basic concepts, then explore GeneralTextMemory and TreeTextMemory.
::
