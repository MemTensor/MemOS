<div align="center">
  <a href="https://memos.openmem.net/">
    <img src="https://statics.memtensor.com.cn/memos/memos-banner.gif" alt="MemOS Banner">
  </a>

  <h1 align="center">
    <img src="https://statics.memtensor.com.cn/logo/memos_color_m.png" alt="MemOS Logo" width="50"/>
    MemOS 2.0: 星尘（Stardust）
    <img src="https://img.shields.io/badge/status-Preview-blue" alt="Preview Badge"/>
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
    <a href="https://github.com/IAAR-Shanghai/Awesome-AI-Memory">
      <img alt="Awesome AI Memory" src="https://img.shields.io/badge/Resources-Awesome--AI--Memory-8A2BE2">
    </a>  
  </p>

<p align="center">
  <strong>🎯 +43.70% Accuracy vs. OpenAI Memory</strong><br/>
  <strong>🏆 Top-tier long-term memory + personalization</strong><br/>
  <strong>💰 Saves 35.24% memory tokens</strong><br/>
  <sub>LoCoMo 75.80 • LongMemEval +40.43% • PrefEval-10 +2568% • PersonaMem +40.75%</sub>
  <a href="https://memos.openmem.net/">
    <img src="https://statics.memtensor.com.cn/memos/github_api_free_banner.gif" alt="MemOS Free API Banner">
  </a>

</p>
  
</div>

Get Free API: [Try API](https://memos-dashboard.openmem.net/quickstart/?source=github)

---

<br>

## 📌 MemOS: Memory Operating System for AI Agents

**MemOS** is a Memory Operating System for LLMs and AI agents that unifies **store / retrieve / manage** for long-term memory, enabling **context-aware and personalized** interactions with **KB**, **multi-modal**, **tool memory**, and **enterprise-grade** optimizations built in.



### Key Features

- **Unified Memory API**: A single API to add, retrieve, edit, and delete memory—structured as a graph, inspectable and editable by design, not a black-box embedding store.
- **Multi-Modal Memory**: Natively supports text, images, tool traces, and personas, retrieved and reasoned together in one memory system.
- **Multi-Cube Knowledge Base Management**: Manage multiple knowledge bases as composable memory cubes, enabling isolation, controlled sharing, and dynamic composition across users, projects, and agents.
- **Asynchronous Ingestion via MemScheduler**: Run memory operations asynchronously with millisecond-level latency for production stability under high concurrency.
- **Memory Feedback & Correction**: Refine memory with natural-language feedback—correcting, supplementing, or replacing existing memories over time.


### News

- **2025-12-24** · 🎉 **MemOS v2.0: Stardust (星尘) Release**  
  Comprehensive KB (doc/URL parsing + cross-project sharing), memory feedback & precise deletion, multi-modal memory (images/charts), tool memory for agent planning, Redis Streams scheduling + DB optimizations, streaming/non-streaming chat, MCP upgrade, and lightweight quick/full deployment.
  <details>
    <summary>✨ <b>New Features</b></summary>

  **Knowledge Base & Memory**
  - Added knowledge base support for long-term memory from documents and URLs

  **Feedback & Memory Management**
  - Added natural language feedback and correction for memories
  - Added memory deletion API by memory ID
  - Added MCP support for memory deletion and feedback

  **Conversation & Retrieval**
  - Added chat API with memory-aware retrieval
  - Added memory filtering with custom tags (Cloud & Open Source)

  **Multimodal & Tool Memory**
  - Added tool memory for tool usage history
  - Added image memory support for conversations and documents

  </details>

  <details>
    <summary>📈 <b>Improvements</b></summary>

  **Data & Infrastructure**
  - Upgraded database for better stability and performance

  **Scheduler**
  - Rebuilt task scheduler with Redis Streams and queue isolation
  - Added task priority, auto-recovery, and quota-based scheduling

  **Deployment & Engineering**
  - Added lightweight deployment with quick and full modes

  </details>

  <details>
    <summary>🐞 <b>Bug Fixes</b></summary>

  **Memory Scheduling & Updates**
  - Fixed legacy scheduling API to ensure correct memory isolation
  - Fixed memory update logging to show new memories correctly

  </details>

- **2025-08-07** · 🎉 **MemOS v1.0.0 (MemCube) Release**  
  First MemCube release with a word-game demo, LongMemEval evaluation, BochaAISearchRetriever integration, NebulaGraph support, improved search capabilities, and the official Playground launch.

  <details>
    <summary>✨ <b>New Features</b></summary>

  **Playground**
  - Expanded Playground features and algorithm performance.

  **MemCube Construction**
  - Added a text game demo based on the MemCube novel.

  **Extended Evaluation Set**
  - Added LongMemEval evaluation results and scripts.

  </details>

  <details>
    <summary>📈 <b>Improvements</b></summary>

  **Plaintext Memory**
  - Integrated internet search with Bocha.
  - Added support for Nebula database.
  - Added contextual understanding for the tree-structured plaintext memory search interface.

  </details>

  <details>
    <summary>🐞 <b>Bug Fixes</b></summary>

  **KV Cache Concatenation**
  - Fixed the concat_cache method.

  **Plaintext Memory**
  - Fixed Nebula search-related issues.

  </details>

- **2025-07-07** · 🎉 **MemOS v1.0: Stellar (星河) Preview Release**  
  A SOTA Memory OS for LLMs is now open-sourced.
- **2025-07-04** · 🎉 **MemOS Paper Release**  
  [MemOS: A Memory OS for AI System](https://arxiv.org/abs/2507.03724) is available on arXiv.
- **2024-07-04** · 🎉 **Memory3 Model Release at WAIC 2024**  
  The Memory3 model, featuring a memory-layered architecture, was unveiled at the 2024 World Artificial Intelligence Conference.

<br>

## 🚀 Quickstart Guide

### ☁️ 1、Cloud API (Hosted)
#### Get API Key
- Sign up on the [MemOS dashboard](https://memos-dashboard.openmem.net/cn/quickstart/?source=landing)
- Go to **API Keys** and copy your key

#### Next Steps
- [MemOS Cloud Getting Started](https://memos-docs.openmem.net/memos_cloud/quick_start/)  
  Connect to MemOS Cloud and enable memory in minutes.
- [MemOS Cloud Platform](https://memos.openmem.net/?from=/quickstart/)  
  Explore the Cloud dashboard, features, and workflows.

### 🖥️ 2、Self-Hosted (Local/Private)
1. Get the repository.
    ```bash
    git clone https://github.com/MemTensor/MemOS.git
    cd MemOS
    pip install -r ./docker/requirements.txt
    ```
2. Configure `docker/.env.example` and copy to `MemOS/.env`
 - The `OPENAI_API_KEY`,`MOS_EMBEDDER_API_KEY`,`MEMRADER_API_KEY` and others can be applied for through [`BaiLian`](https://bailian.console.aliyun.com/?spm=a2c4g.11186623.0.0.2f2165b08fRk4l&tab=api#/api).
 - Fill in the corresponding configuration in the `MemOS/.env` file.
3. Start the service.

- Launch via Docker
  ###### Tips: Please ensure that Docker Compose is installed successfully and that you have navigated to the docker directory (via `cd docker`) before executing the following command.
  ```bash
  # Enter docker directory
  docker compose up
  ```
  ##### For detailed steps, see the[`Docker Reference`](https://docs.openmem.net/open_source/getting_started/rest_api_server/#method-1-docker-use-repository-dependency-package-imagestart-recommended-use).

- Launch via the uvicorn command line interface (CLI)
  ###### Tips: Please ensure that Neo4j and Qdrant are running before executing the following command.
  ```bash
  uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8001 --workers 1
  ```
  ##### For detailed integration steps, see the [`CLI Reference`](https://docs.openmem.net/open_source/getting_started/rest_api_server/#method-3client-install-with-CLI).



### Basic Usage (Self-Hosted)
  - Add User Message
    ```python
    import requests
    import json
    
    data = {
        "user_id": "8736b16e-1d20-4163-980b-a5063c3facdc",
        "mem_cube_id": "b32d0977-435d-4828-a86f-4f47f8b55bca",
        "messages": [
            {
                "role": "user",
                "content": "I like strawberry"
            }
        ],
        "async_mode": "sync"
    }
    headers = {
        "Content-Type": "application/json"
    }
    url = "http://localhost:8000/product/add"
    
    res = requests.post(url=url, headers=headers, data=json.dumps(data))
    print(f"result: {res.json()}")
    ```
  - Search User Memory
    ```python
    import requests
    import json
    
    data = {
        "query": "What do I like",
        "user_id": "8736b16e-1d20-4163-980b-a5063c3facdc",
        "mem_cube_id": "b32d0977-435d-4828-a86f-4f47f8b55bca"
    }
    headers = {
        "Content-Type": "application/json"
    }
    url = "http://localhost:8000/product/search"
    
    res = requests.post(url=url, headers=headers, data=json.dumps(data))
    print(f"result: {res.json()}")
    ```

<br>

## 📚 Resources

>  **Awesome-AI-Memory** : A curated collection of LLM memory resources: **papers / frameworks / tools / practices**  
>  This is a curated repository dedicated to resources on memory and memory systems for large language models. It systematically collects relevant research papers, frameworks, tools, and practical insights. The repository aims to organize and present the rapidly evolving research landscape of LLM memory, bridging multiple research directions including natural language processing, information retrieval, agentic systems, and cognitive science.  
>  ** Start to learn** 👉 https://github.com/IAAR-Shanghai/Awesome-AI-Memory

<br>

## 💬 Community & Support

Join our community to ask questions, share your projects, and connect with other developers.

- **GitHub Issues**: Report bugs or request features in our <a href="https://github.com/MemTensor/MemOS/issues" target="_blank">GitHub Issues</a>.
- **GitHub Pull Requests**: Contribute code improvements via <a href="https://github.com/MemTensor/MemOS/pulls" target="_blank">Pull Requests</a>.
- **GitHub Discussions**: Participate in our <a href="https://github.com/MemTensor/MemOS/discussions" target="_blank">GitHub Discussions</a> to ask questions or share ideas.
- **Discord**: Join our <a href="https://discord.gg/Txbx3gebZR" target="_blank">Discord Server</a>.
- **WeChat**: Scan the QR code to join our WeChat group.

<div align="center">
  <img src="https://statics.memtensor.com.cn/memos/qr-code.png" alt="QR Code" width="300" />
</div>

<br>

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

<br>

## 🙌 Contributing

We welcome contributions from the community! Please read our [contribution guidelines](https://memos-docs.openmem.net/contribution/overview) to get started.

<br>

## 📄 License

MemOS is licensed under the [Apache 2.0 License](./LICENSE).