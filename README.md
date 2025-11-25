# MemOS: Memory Operating System for AI Agents

MemOS is an open-source **Agent Memory framework** that empowers AI agents with **long-term memory, personality consistency, and contextual recall**. It enables agents to **remember past interactions**, **learn over time**, and **build evolving identities** across sessions.

Designed for **AI companions, role-playing NPCs, and multi-agent systems**, MemOS provides a unified API for **memory representation, retrieval, and update** — making it the foundation for next-generation **memory-augmented AI agents**.
<div align="center">
  <a href="https://memos.openmem.net/">
    <img src="https://statics.memtensor.com.cn/memos/memos-banner.gif" alt="MemOS Banner">
  </a>

<h1 align="center">
  <img src="https://statics.memtensor.com.cn/logo/memos_color_m.png" alt="MemOS Logo" width="50"/> MemOS 1.0: 星河 (Stellar)  <img src="https://img.shields.io/badge/status-Preview-blue" alt="Preview Badge"/>
</h1>

  <p>
    <a href="https://www.memtensor.com.cn/">
      <img alt="Static Badge" src="https://img.shields.io/badge/Maintained_by-MemTensor-blue">
    </a>
    <a href="https://pypi.org/project/MemoryOS">
      <img src="https://img.shields.io/pypi/v/MemoryOS?label=pypi%20package" alt="PyPI Version">
    </a>
    <a href="https://pypi.org/project/MemoryOS">
      <img src="https://img.shields.io/pypi/pyversions/MemoryOS.svg" alt="Supported Python versions">
    </a>
    <a href="https://pypi.org/project/MemoryOS">
      <img src="https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey" alt="Supported Platforms">
    </a>
    <a href="https://memos-docs.openmem.net/home/overview/">
      <img src="https://img.shields.io/badge/Documentation-view-blue.svg" alt="Documentation">
    </a>
    <a href="https://arxiv.org/abs/2507.03724">
        <img src="https://img.shields.io/badge/arXiv-2507.03724-b31b1b.svg" alt="ArXiv Paper">
    </a>
    <a href="https://github.com/MemTensor/MemOS/discussions">
      <img src="https://img.shields.io/badge/GitHub-Discussions-181717.svg?logo=github" alt="GitHub Discussions">
    </a>
    <a href="https://discord.gg/Txbx3gebZR">
      <img src="https://img.shields.io/badge/Discord-join%20chat-7289DA.svg?logo=discord" alt="Discord">
    </a>
    <a href="https://statics.memtensor.com.cn/memos/qr-code.png">
      <img src="https://img.shields.io/badge/WeChat-Group-07C160.svg?logo=wechat" alt="WeChat Group">
    </a>
    <a href="https://opensource.org/license/apache-2-0/">
      <img src="https://img.shields.io/badge/License-Apache_2.0-green.svg?logo=apache" alt="License">
    </a>
  </p>


<a href="https://memos.openmem.net/">
  <img src="https://statics.memtensor.com.cn/memos/github_api_free_banner.gif" alt="MemOS Free API Banner">
</a>

</div>


Get Free API: [Try API](https://memos-dashboard.openmem.net/quickstart/?source=github)


---

<img src="https://cdn.memtensor.com.cn/img/1762436050812_3tgird_compressed.png" alt="SOTA SCORE">

**MemOS** is an operating system for Large Language Models (LLMs) that enhances them with long-term memory capabilities. It allows LLMs to store, retrieve, and manage information, enabling more context-aware, consistent, and personalized interactions.

- **Website**: https://memos.openmem.net/
- **Documentation**: https://memos-docs.openmem.net/home/overview/
- **API Reference**: https://memos-docs.openmem.net/api-reference/configure-memos/
- **Source Code**: https://github.com/MemTensor/MemOS

## 📰 News

Stay up to date with the latest MemOS announcements, releases, and community highlights.


- **2025-11-06** - 🎉 MemOS v1.1.3 (Async Memory & Preference):
  Millisecond-level async memory add (support plain-text-memory and
  preference memory); enhanced BM25, graph recall, and mixture search; full
  results & code for LoCoMo, LongMemEval, PersonaMem, and PrefEval released.
- **2025-10-30** - 🎉 MemOS v1.1.2 (API & MCP Update):
API architecture overhaul and full MCP (Model Context Protocol) support — enabling models, IDEs, and agents to read/write external memory directly.
- **2025-09-10** - 🎉 *MemOS v1.0.1 (Group Q&A Bot)*: Group Q&A bot based on MemOS Cube, updated KV-Cache performance comparison data across different GPU deployment schemes, optimized test benchmarks and statistics, added plaintext memory Reranker sorting, optimized plaintext memory hallucination issues, and Playground version updates. [Try PlayGround](https://memos-playground.openmem.net/login/)
- **2025-08-07** - 🎉 *MemOS v1.0.0 (MemCube Release)*: First MemCube with word game demo, LongMemEval evaluation, BochaAISearchRetriever integration, NebulaGraph support, enhanced search capabilities, and official Playground launch.
- **2025-07-29** – 🎉 *MemOS v0.2.2 (Nebula Update)*: Internet search+Nebula DB integration, refactored memory scheduler, KV Cache stress tests, MemCube Cookbook release (CN/EN), and 4b/1.7b/0.6b memory ops models.
- **2025-07-21** – 🎉 *MemOS v0.2.1 (Neo Release)*: Lightweight Neo version with plaintext+KV Cache functionality, Docker/multi-tenant support, MCP expansion, and new Cookbook/Mud game examples.
- **2025-07-11** – 🎉 *MemOS v0.2.0 (Cross-Platform)*: Added doc search/bilingual UI, MemReader-4B (local deploy), full Win/Mac/Linux support, and playground end-to-end connection.
- **2025-07-07** – 🎉 *MemOS 1.0 (Stellar) Preview Release*: A SOTA Memory OS for LLMs is now open-sourced.
- **2025-07-04** – 🎉 *MemOS Paper Released*: [MemOS: A Memory OS for AI System](https://arxiv.org/abs/2507.03724) was published on arXiv.
- **2025-05-28** – 🎉 *Short Paper Uploaded*: [MemOS: An Operating System for Memory-Augmented Generation (MAG) in Large Language Models](https://arxiv.org/abs/2505.22101) was published on arXiv.
- **2024-07-04** – 🎉 *Memory3 Model Released at WAIC 2024*: The new memory-layered architecture model was unveiled at the 2024 World Artificial Intelligence Conference.
- **2024-07-01** – 🎉 *Memory3 Paper Released*: [Memory3: Language Modeling with Explicit Memory](https://arxiv.org/abs/2407.01178) introduces the new approach to structured memory in LLMs.

## 📈 Performance Benchmark

MemOS demonstrates significant improvements over baseline memory solutions in multiple memory tasks,
showcasing its capabilities in **information extraction**, **temporal and cross-session reasoning**, and **personalized preference responses**.

| Model           | LOCOMO      | LongMemEval | PrefEval-10 | PersonaMem  |
|-----------------|-------------|-------------|-------------|-------------|
| **GPT-4o-mini** | 52.75       | 55.4        | 2.8         | 43.46       |
| **MemOS**       | **75.80**   | **77.80**   | **71.90**   | **61.17**   |
| **Improvement** | **+43.70%** | **+40.43%** | **+2568%**  | **+40.75%** |

### Detailed Evaluation Results
- We use gpt-4o-mini as the processing and judging LLM and bge-m3 as embedding model in MemOS evaluation.
- The evaluation was conducted under conditions that align various settings as closely as possible. Reproduce the results with our scripts at [`evaluation`](./evaluation).
- Check the full search and response details at huggingface https://huggingface.co/datasets/MemTensor/MemOS_eval_result.
> 💡 **MemOS outperforms all other methods (Mem0, Zep, Memobase, SuperMemory et al.) across all benchmarks!**

## ✨ Key Features

- **🧠 Memory-Augmented Generation (MAG)**: Provides a unified API for memory operations, integrating with LLMs to enhance chat and reasoning with contextual memory retrieval.
- **📦 Modular Memory Architecture (MemCube)**: A flexible and modular architecture that allows for easy integration and management of different memory types.
- **💾 Multiple Memory Types**:
    - **Textual Memory**: For storing and retrieving unstructured or structured text knowledge.
    - **Activation Memory**: Caches key-value pairs (`KVCacheMemory`) to accelerate LLM inference and context reuse.
    - **Parametric Memory**: Stores model adaptation parameters (e.g., LoRA weights).
- **🔌 Extensible**: Easily extend and customize memory modules, data sources, and LLM integrations.

## 🚀 Getting Started

### ⭐️ MemOS online API
The easiest way to use MemOS. Equip your agent with memory **in minutes**!

Sign up and get started on[`MemOS dashboard`](https://memos-dashboard.openmem.net/cn/quickstart/?source=landing).


### Self-Hosted Server
1. Get the repository.
```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS
pip install -r ./docker/requirements.txt
```

2. Configure `docker/.env.example` and copy to `MemOS/.env`
3. Start the service.
```bash
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8001 --workers 8
```

### Local SDK
Here's a quick example of how to create a **`MemCube`**, load it from a directory, access its memories, and save it.

```python
from memos.mem_cube.general import GeneralMemCube

# Initialize a MemCube from a local directory
mem_cube = GeneralMemCube.init_from_dir("examples/data/mem_cube_2")

# Access and print all memories
print("--- Textual Memories ---")
for item in mem_cube.text_mem.get_all():
    print(item)

print("\n--- Activation Memories ---")
for item in mem_cube.act_mem.get_all():
    print(item)

# Save the MemCube to a new directory
mem_cube.dump("tmp/mem_cube")
```

**`MOS`** (Memory Operating System) is a higher-level orchestration layer that manages multiple MemCubes and provides a unified API for memory operations. Here's a quick example of how to use MOS:

```python
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS


# init MOS
mos_config = MOSConfig.from_json_file("examples/data/config/simple_memos_config.json")
memory = MOS(mos_config)

# create user
user_id = "b41a34d5-5cae-4b46-8c49-d03794d206f5"
memory.create_user(user_id=user_id)

# register cube for user
memory.register_mem_cube("examples/data/mem_cube_2", user_id=user_id)

# add memory for user
memory.add(
    messages=[
        {"role": "user", "content": "I like playing football."},
        {"role": "assistant", "content": "I like playing football too."},
    ],
    user_id=user_id,
)

# Later, when you want to retrieve memory for user
retrieved_memories = memory.search(query="What do you like?", user_id=user_id)
# output text_memories: I like playing football, act_memories, para_memories
print(f"text_memories: {retrieved_memories['text_mem']}")
```

For more detailed examples, please check out the [`examples`](./examples) directory.

## 📦 Installation

### Install via pip

```bash
pip install MemoryOS
```

### Optional Dependencies

MemOS provides several optional dependency groups for different features. You can install them based on your needs.

| Feature               | Package Name              |
| --------------------- | ------------------------- |
| Tree Memory           | `MemoryOS[tree-mem]`      |
| Memory Reader         | `MemoryOS[mem-reader]`    |
| Memory Scheduler      | `MemoryOS[mem-scheduler]` |

Example installation commands:

```bash
pip install MemoryOS[tree-mem]
pip install MemoryOS[tree-mem,mem-reader]
pip install MemoryOS[mem-scheduler]
pip install MemoryOS[tree-mem,mem-reader,mem-scheduler]
```

### External Dependencies

#### Ollama Support

To use MemOS with [Ollama](https://ollama.com/), first install the Ollama CLI:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

#### Transformers Support

To use functionalities based on the `transformers` library, ensure you have [PyTorch](https://pytorch.org/get-started/locally/) installed (CUDA version recommended for GPU acceleration).

#### Download Examples

To download example code, data and configurations, run the following command:

```bash
memos download_examples
```

## 💬 Community & Support

Join our community to ask questions, share your projects, and connect with other developers.

- **GitHub Issues**: Report bugs or request features in our <a href="https://github.com/MemTensor/MemOS/issues" target="_blank">GitHub Issues</a>.
- **GitHub Pull Requests**: Contribute code improvements via <a href="https://github.com/MemTensor/MemOS/pulls" target="_blank">Pull Requests</a>.
- **GitHub Discussions**: Participate in our <a href="https://github.com/MemTensor/MemOS/discussions" target="_blank">GitHub Discussions</a> to ask questions or share ideas.
- **Discord**: Join our <a href="https://discord.gg/Txbx3gebZR" target="_blank">Discord Server</a>.
- **WeChat**: Scan the QR code to join our WeChat group.

<img src="https://statics.memtensor.com.cn/memos/qr-code.png" alt="QR Code" width="600">

## 📜 Citation

> [!NOTE]
> We publicly released the Short Version on **May 28, 2025**, making it the earliest work to propose the concept of a Memory Operating System for LLMs.

If you use MemOS in your research, we would appreciate citations to our papers.

```bibtex

@article{li2025memos_long,
  title={MemOS: A Memory OS for AI System},
  author={Li, Zhiyu and Song, Shichao and Xi, Chenyang and Wang, Hanyu and Tang, Chen and Niu, Simin and Chen, Ding and Yang, Jiawei and Li, Chunyu and Yu, Qingchen and Zhao, Jihao and Wang, Yezhaohui and Liu, Peng and Lin, Zehao and Wang, Pengyuan and Huo, Jiahao and Chen, Tianyi and Chen, Kai and Li, Kehang and Tao, Zhen and Ren, Junpeng and Lai, Huayi and Wu, Hao and Tang, Bo and Wang, Zhenren and Fan, Zhaoxin and Zhang, Ningyu and Zhang, Linfeng and Yan, Junchi and Yang, Mingchuan and Xu, Tong and Xu, Wei and Chen, Huajun and Wang, Haofeng and Yang, Hongkang and Zhang, Wentao and Xu, Zhi-Qin John and Chen, Siheng and Xiong, Feiyu},
  journal={arXiv preprint arXiv:2507.03724},
  year={2025},
  url={https://arxiv.org/abs/2507.03724}
}

@article{li2025memos_short,
  title={MemOS: An Operating System for Memory-Augmented Generation (MAG) in Large Language Models},
  author={Li, Zhiyu and Song, Shichao and Wang, Hanyu and Niu, Simin and Chen, Ding and Yang, Jiawei and Xi, Chenyang and Lai, Huayi and Zhao, Jihao and Wang, Yezhaohui and others},
  journal={arXiv preprint arXiv:2505.22101},
  year={2025},
  url={https://arxiv.org/abs/2505.22101}
}

@article{yang2024memory3,
author = {Yang, Hongkang and Zehao, Lin and Wenjin, Wang and Wu, Hao and Zhiyu, Li and Tang, Bo and Wenqiang, Wei and Wang, Jinbo and Zeyun, Tang and Song, Shichao and Xi, Chenyang and Yu, Yu and Kai, Chen and Xiong, Feiyu and Tang, Linpeng and Weinan, E},
title = {Memory$^3$: Language Modeling with Explicit Memory},
journal = {Journal of Machine Learning},
year = {2024},
volume = {3},
number = {3},
pages = {300--346},
issn = {2790-2048},
doi = {https://doi.org/10.4208/jml.240708},
url = {https://global-sci.com/article/91443/memory3-language-modeling-with-explicit-memory}
}
```

## 🙌 Contributing

We welcome contributions from the community! Please read our [contribution guidelines](https://memos-docs.openmem.net/contribution/overview) to get started.

## 📄 License

MemOS is licensed under the [Apache 2.0 License](./LICENSE).
