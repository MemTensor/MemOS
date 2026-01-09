# MemOS: Memory Operating System for AI Agents

MemOS is an open-source **Agent Memory framework** that empowers AI agents with **long-term memory, personality consistency, and contextual recall**. It enables agents to **remember past interactions**, **learn over time**, and **build evolving identities** across sessions.

Designed for **AI companions, role-playing NPCs, and multi-agent systems**, MemOS provides a unified API for **memory representation, retrieval, and update** — making it the foundation for next-generation **memory-augmented AI agents**.
<div align="center">
  <a href="https://memos.openmem.net/">
    <img src="https://statics.memtensor.com.cn/memos/memos-banner.gif" alt="MemOS Banner">
  </a>

<h1 align="center">
  <img src="https://statics.memtensor.com.cn/logo/memos_color_m.png" alt="MemOS Logo" width="50"/> MemOS 2.0: 星尘（Stardust） <img src="https://img.shields.io/badge/status-Preview-blue" alt="Preview Badge"/>
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

**MemOS** is an operating system for Large Language Models (LLMs) that enhances them with long-term memory capabilities. It allows LLMs to store, retrieve, and manage information, enabling more context-aware, consistent, and personalized interactions. **MemOS 2.0** features comprehensive knowledge base management, multi-modal memory support, tool memory for Agent enhancement, and enterprise-grade architecture optimizations.

- **Website**: https://memos.openmem.net/
- **Documentation**: https://memos-docs.openmem.net/home/overview/
- **API Reference**: https://memos-docs.openmem.net/api-reference/configure-memos/
- **Source Code**: https://github.com/MemTensor/MemOS

## 📰 News

Stay up to date with the latest MemOS announcements, releases, and community highlights.

- **2025-12-24** - 🎉 **MemOS v2.0: Stardust (星尘) Release**:
  Major upgrade featuring comprehensive Knowledge Base system with automatic document/URL parsing and cross-project sharing; Memory feedback mechanism for correction and precise deletion; Multi-modal memory supporting images and charts; Tool Memory to enhance Agent planning; Full architecture upgrade with Redis Streams multi-level queue scheduler and DB optimizations; New streaming/non-streaming Chat interfaces; Complete MCP upgrade; Lightweight deployment modes (quick & full).
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
- **🏂 Lightweight Deployment** 🆕: Support for quick mode and complete mode deployment options.


## 🚀 Quickstart Guide

### Get API Key
  - Sign up and get started on[`MemOS dashboard`](https://memos-dashboard.openmem.net/cn/quickstart/?source=landing)
  - Open the API Keys Console in the MemOS dashboard and copy the API Key into the initialization code

### Install via pip

```bash
pip install MemoryOS -U
```

### Basic Usage

- Initialize MemOS client with API Key to start sending requests
```python
# Please make sure MemoS is installed (pip install MemoryOS -U)
from memos.api.client import MemOSClient

# Initialize the client using the API Key
client = MemOSClient(api_key="YOUR_API_KEY")
```

- This API allows you to add one or more messages to a specific conversation. As illustrated in the examples bellow, you can add messages in real time during a user-assistant interaction, import historical messages in bulk, or enrich the conversation with user preferences and behavior data. All added messages are transformed into memories by MemOS, enabling their retrieval in future conversations to support chat history management, user behavior tracking, and personalized interactions.
```python
messages = [
  {"role": "user", "content": "I have planned to travel to Guangzhou during the summer vacation. What chain hotels are available for accommodation?"},
  {"role": "assistant", "content": "You can consider [7 Days, All Seasons, Hilton], and so on."},
  {"role": "user", "content": "I'll choose 7 Days"},
  {"role": "assistant", "content": "Okay, ask me if you have any other questions."}
]
user_id = "memos_user_123"
conversation_id = "0610"
res = client.add_message(messages=messages, user_id=user_id, conversation_id=conversation_id)

print(f"result: {res}")
```

- This API allows you to query a user’s memory and returns the fragments most relevant to the input. These can serve as references for the model when generating responses. As shown in the examples bellow, You can retrieve memory in real time during a user’s conversation with the AI, or perform a global search across their entire memory to create user profiles or support personalized recommendations, improving both dialogue coherence and personalization.
In the latest update, in addition to “Fact Memory”, the system now supports “Preference Memory”, enabling LLM to respond in a way that better understands the user.
```python
query = "I want to go out to play during National Day. Can you recommend a city I haven't been to and a hotel brand I haven't stayed at?"
user_id = "memos_user_123"
conversation_id = "0610"
res = client.search_memory(query=query, user_id=user_id, conversation_id=conversation_id)

print(f"result: {res}")
```


### Self-Hosted Server
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
  ##### If you prefer to deploy using Docker, please refer to the [`Docker Reference`](https://docs.openmem.net/open_source/getting_started/rest_api_server/#method-1-docker-use-repository-dependency-package-imagestart-recommended-use).

- Launch via the uvicorn command line interface (CLI)
  ###### Tips: Please ensure that Neo4j and Qdrant are running before executing the following command.
  ```bash
  uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8001 --workers 1
  ```
  ##### For detailed integration steps, see the [`CLI Reference`](https://docs.openmem.net/open_source/getting_started/rest_api_server/#method-3client-install-with-CLI).



Example
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