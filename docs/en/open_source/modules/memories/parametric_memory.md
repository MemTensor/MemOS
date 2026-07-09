---
title: Parametric Memory *(Coming Soon)*
---

::note
**Coming Soon**
This feature is still under active development. Stay tuned for updates!
::

`Parametric Memory` is the core **long-term knowledge and capability store** inside MemOS.
Unlike plaintext or activation memories, parametric memory is embedded directly within a model’s weights — encoding deep representations of language structure, world knowledge, and general reasoning abilities.

In the MemOS architecture, parametric memory does not just refer to static pre-trained weights. It also includes modular weight components such as **LoRA adapters** and plug-in expert modules. These allow you to incrementally expand or specialize your LLM’s capabilities without retraining the entire model.

For example, you could distill structured or stable knowledge into parametric form, save it as a **capability block**, and dynamically load or unload it during inference. This makes it easy to create “expert sub-models” for tasks like legal reasoning, financial analysis, or domain-specific summarization — all managed by MemOS.


## Design Goals

::list{icon="ph:check-circle-duotone"}
-  **Controllability** — Generate, load, swap, or compose parametric modules
   on demand.
-  **Plasticity** — Evolve alongside plaintext and activation memories; support knowledge distillation and rollback.
-  **Traceability** *(Coming Soon)* — Versioning and governance for parametric blocks.
::

## Current Status

`Parametric Memory` is currently under design and prototyping.
APIs for generating, compressing, and hot-swapping parametric modules will be released in future versions — supporting multi-task, multi-role, and multi-agent architectures.

Stay tuned!


## Related Modules

While parametric memory is under development, try out these today:
- **[GeneralTextMemory](/open_source/modules/memories/general_textual_memory)**: Flexible vector-based semantic storage.
- **[TreeTextMemory](/open_source/modules/memories/tree_textual_memory)**: Structured, hierarchical knowledge graphs.
- **[Activation Memory](/open_source/modules/memories/kv_cache_memory)**: Efficient runtime state caching.

## Developer Note

Parametric Memory will complete MemOS’s vision of a unified **Memory³** architecture:
- **Parametric**: Embedded knowledge
- **Activation**: Ephemeral runtime states
- **Plaintext**: Structured, traceable external memories

Bringing all three together enables adaptable, evolvable, and explainable intelligent systems.
