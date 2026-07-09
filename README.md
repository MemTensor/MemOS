<div align="center">
  <h1 align="center">
    <a href="https://memos.openmem.net/">
      <img src="https://statics.memtensor.com.cn/logo/memos_color_m.png" alt="MemOS Logo" width="48"/>
    </a>&nbsp;
    MemOS 2.0&ensp;Stardust（星尘）
  </h1>

  <p align="center">
    <a href="https://memos-docs.openmem.net/home/overview/"><img src="https://img.shields.io/badge/Docs-Get--Start-002FA7?labelColor=gray&style=for-the-badge&logo=googledocs&logoColor=white" alt="Docs"></a>
    <a href="https://arxiv.org/abs/2507.03724"><img src="https://img.shields.io/badge/ArXiv-2507.03724-B31B1B?labelColor=gray&style=for-the-badge&logo=arxiv&logoColor=white" alt="ArXiv"></a>
    <a href="https://x.com/MemOS_dev"><img src="https://img.shields.io/badge/Follow-MemOS-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
    <a href="https://discord.gg/Txbx3gebZR"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FTxbx3gebZR%3Fwith_counts%3Dtrue&query=%24.approximate_presence_count&suffix=%20online&label=Discord&color=404EED&labelColor=gray&style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
    <br>
    <a href="https://github.com/IAAR-Shanghai/Awesome-AI-Memory"><img src="https://img.shields.io/badge/Resources-Awesome--AI--Memory-8A2BE2?labelColor=gray&style=for-the-badge&logo=awesomelists&logoColor=white" alt="Resources"></a>
  </p>

  <p align="center">
    <strong>Give your Agent persistent memory and the ability to grow.</strong><br/>
  </p>

  <p align="center">
    <strong>English</strong> | <a href="README_ZH.md">中文</a>
  </p>
</div>


<div align="center">
  <img width="1660" height="664" alt="MemOS Plugin Banner" src="https://github.com/user-attachments/assets/9d15dde2-196e-4f71-a364-dd5a33062117" />
</div>

---

## 👾 MemOS: Memory Operating System for LLM & AI Agents

**MemOS** is a Memory Operating System for LLMs and AI agents that unifies **store / retrieve / manage** for long-term memory, enabling **context-aware and personalized** interactions with **KB**, **multi-modal**, **tool memory**, and **enterprise-grade** optimizations built in.

### Key Features

- **Unified Memory API**: A single API to add, retrieve, edit, and delete memory—structured as a graph, inspectable and editable by design, not a black-box embedding store.
- **Multi-Modal Memory**: Natively supports text, images, tool traces, and personas, retrieved and reasoned together in one memory system.
- **Multi-Cube Knowledge Base Management**: Manage multiple knowledge bases as composable memory cubes, enabling isolation, controlled sharing, and dynamic composition across users, projects, and agents.
- **Asynchronous Ingestion via MemScheduler**: Run memory operations asynchronously with millisecond-level latency for production stability under high concurrency.
- **Memory Feedback & Correction**: Refine memory with natural-language feedback—correcting, supplementing, or replacing existing memories over time.


### News

- **2026-07-02** · 🏆 **MemOS Advances Agent and User Memory Benchmarks**
  With MemOS, **OpenClaw** improves average task completion from **36.63% to 50.87%** across five agent tasks. MemOS also achieves **92.34 on LoCoMo** and **93.40 on LongMemEval**, and leads in **OmniMemEval**, a unified evaluation of 14 commercial memory products across ten datasets.

- **2026-05-09** · 🧠 **memos-local-plugin 2.0**
  Official local memory plugin for **Hermes Agent** and **OpenClaw**. One core powers self-evolving memory across L1 traces, L2 policies, L3 world models, and crystallized Skills, with local-first storage and feedback-driven retrieval.

- **2026-04-10** · 👧🏻 **MemOS Hermes Agent Local Plugin**
  Official Hermes Agent memory plugins launched: Hybrid retrieval (FTS5 + vector), smart dedup, tiered skill evolution, multi-agent collaboration. 100% local, zero cloud dependency.
  
- **2026-03-08** · 🦞 **MemOS OpenClaw Plugin — Cloud & Local**
  Official OpenClaw memory plugins launched. **Cloud Plugin**: hosted memory service with 72% lower token usage and multi-agent memory sharing ([MemOS-Cloud-OpenClaw-Plugin](https://github.com/MemTensor/MemOS-Cloud-OpenClaw-Plugin)). **Local Plugin** (`v1.0.0`): 100% on-device memory with persistent SQLite, hybrid search (FTS5 + vector), task summarization & skill evolution, multi-agent collaboration, and a full Memory Viewer dashboard.

## 📊 Performance

MemOS leads across multiple benchmarks — evaluated against mainstream commercial memory products across 5 user memory and 5 agent memory tasks.


| Benchmark       | Score |
| --------------- | ----- |
| LoCoMo          | 88.83 |
| LongMemEval     | 89.20 |
| PersonaMem v2   | 40.58 |
| HaluMem         | 80.91 |
| BEAM-10M        | 56.75 |
| GDPVal          | 62.07 |
| LiveCodeBench   | 64.96 |
| OmniMath        | 61.00 |
| SWE-Bench       | 38.46 |
| BrowseComp-Plus | 23.85 |


Evaluated via OmniMemEval — [https://github.com/MemTensor/OmniMemEval](https://github.com/MemTensor/OmniMemEval).

## 🎯 What MemOS Is For

MemOS gives AI agents long-term memory. Common uses:

- AI assistants with consistent, context-rich conversations
- Customer support that recalls past tickets and user history
- Personalized agents that adapt to individual preferences
- Multi-agent collaboration with shared or isolated memory

## 🚀 Quick Start

MemOS is built around four entry points. Pick the one that matches your scenario.


|              | Cloud API               | Self-Host          | OpenClaw Cloud Plugin    | Local Plugin                    |
| ------------ | ----------------------- | ------------------ | ------------------------ | ------------------------------- |
| Best for     | Your app, fully managed | Teams on own infra | OpenClaw users, zero ops | Hermes/OpenClaw, 100% on-device |
| Setup        | Get an API key          | docker compose up  | openclaw plugins install | npm install + config            |
| Infra needed | None (hosted)           | Neo4j + Qdrant     | None (uses MemOS Cloud)  | None (local SQLite)             |
| Data lives   | MemOS Cloud             | Your servers       | MemOS Cloud              | Your machine                    |

### ☁️ Use the Cloud API (Hosted)

You want to add memory to your app through a fully managed service — no infrastructure to run.

**1. Get an API key:**

- Sign up on the [MemOS dashboard](https://memos-dashboard.openmem.net/cn/quickstart/?source=landing).
- Go to **API Keys** and copy your key (starts with `mpg-`). Keep it server-side.

**2. Add and search memories:**

```python
import requests

API_KEY = "mpg-..."                  # keep this server-side
base = "https://memos.memtensor.cn/api/openmem/v1"
headers = {"Authorization": f"Token {API_KEY}", "Content-Type": "application/json"}

# 1. Add a memory
requests.post(f"{base}/add/message", headers=headers, json={
    "user_id": "alice",
    "conversation_id": "conv_001",
    "messages": [{"role": "user", "content": "I like strawberry"}],
})

# 2. Search memories
res = requests.post(f"{base}/search/memory", headers=headers, json={
    "query": "What do I like?",
    "user_id": "alice",
})
print(res.json())
```

**Next steps:**

- [MemOS Cloud Getting Started](https://memos-docs.openmem.net/memos_cloud/quick_start/) — connect to MemOS Cloud and enable memory in minutes.
- [MemOS Cloud Platform](https://memos.openmem.net/?from=/quickstart/) — explore the Cloud dashboard, features, and workflows.

### 🖥️ Self-Host the MemOS Service

You want to run MemOS as a REST service on your own machine or cluster.

**Option A — Docker (recommended):**

```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS
cp docker/.env.example .env          # fill in your API keys in .env
cd docker
docker compose up                    # starts MemOS API + Neo4j + Qdrant
```

The API is served at `http://localhost:8000`.

**Option B — Run with uvicorn (without Docker):**

```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS
cp docker/.env.example .env          # fill in your API keys in .env
# Ensure Neo4j and Qdrant are running, then:
cd src
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8000 --workers 1
```

See `[docker/.env.example](./docker/.env.example)` for all configuration options (LLM provider, embedder, vector DB, graph DB, scheduler). The full deployment guide is at [https://memos-docs.openmem.net/open_source/getting_started/rest_api_server/](https://memos-docs.openmem.net/open_source/getting_started/rest_api_server/).

**Try the API:**

```python
import requests, json

headers = {"Content-Type": "application/json"}
base = "http://localhost:8000/product"

# 1. Create a memory cube
requests.post(f"{base}/create_cube", headers=headers, data=json.dumps({
    "cube_name": "Alice's memory",
    "owner_id": "alice",
    "cube_id": "alice_cube",
}))

# 2. Add a memory
requests.post(f"{base}/add", headers=headers, data=json.dumps({
    "user_id": "alice",
    "writable_cube_ids": ["alice_cube"],
    "messages": [{"role": "user", "content": "I like strawberry"}],
    "async_mode": "sync",
}))

# 3. Search memories
res = requests.post(f"{base}/search", headers=headers, data=json.dumps({
    "query": "What do I like?",
    "user_id": "alice",
    "readable_cube_ids": ["alice_cube"],
}))
print(res.json())
```

### 🧠 MemOS Plugin: Persistent Memory for Your AI Agents ✨

Your OpenClaw and Hermes Agents now have **the best** memory system — choose ***Cloud Service*** or ***Self-hosted*** to get started 🏃🏻

| 🔌 Plugin                                                                                                     | 💡 Core Features | 🧩 Resources                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🧠 **[memos-local-plugin 2.0](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)**         |                  | 🌐 [Website](https://memos-claw.openmem.net/) · 📖 [Docs](https://memos-docs.openmem.net/cn/openclaw/local_plugin) · 🐙 [GitHub](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) · 📦 [NPM](https://www.npmjs.com/package/@memtensor/memos-local-plugin) |
| ☁️ **[OpenClaw Cloud Plugin](https://github.com/MemTensor/MemOS/tree/main/apps/MemOS-Cloud-OpenClaw-Plugin)** |                  | 🖥️ [MemOS Dashboard](https://memos-dashboard.openmem.net/login/) · 📖 [Full Tutorial](https://memos-docs.openmem.net/openclaw/guide#_4-update-plugin)                                                                                                                         |

#### 1. OpenClaw Cloud Plugin

You use OpenClaw and want persistent memory via MemOS Cloud — no infrastructure to run.

- **Repo:** [MemTensor/MemOS ·](https://github.com/MemTensor/MemOS/tree/main/apps/MemOS-Cloud-OpenClaw-Plugin) `apps/MemOS-Cloud-OpenClaw-Plugin`
- **NPM:** `[@memtensor/memos-cloud-openclaw-plugin](https://www.npmjs.com/package/@memtensor/memos-cloud-openclaw-plugin)`
- **Dashboard:** [https://memos-dashboard.openmem.net/](https://memos-dashboard.openmem.net/)
- **Tutorial:** [https://memos-docs.openmem.net/openclaw/guide](https://memos-docs.openmem.net/openclaw/guide)

Install:

```bash
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

The plugin recalls memories from MemOS Cloud before each agent run and saves new messages back after the run ends.

#### 2. Local Plugin (memos-local-plugin 2.0)

You use Hermes Agent or OpenClaw and want 100% on-device memory — nothing leaves your machine.

- **Repo:** [MemTensor/MemOS ·](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) `apps/memos-local-plugin`
- **NPM:** `[@memtensor/memos-local-plugin](https://www.npmjs.com/package/@memtensor/memos-local-plugin)`
- **Docs:** [https://memos-docs.openmem.net/cn/openclaw/local_plugin](https://memos-docs.openmem.net/cn/openclaw/local_plugin)
- **Viewer dashboard:** see `apps/memos-local-plugin/viewer/`

Install (macOS / Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh | bash
```

Install (Windows PowerShell):

```powershell
irm https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.ps1 -OutFile "$env:TEMP\memos-install.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\memos-install.ps1"
```

Requires Node.js and an already-installed OpenClaw or Hermes. The installer auto-detects OpenClaw and Hermes, deploys the plugin to the right agent home (`~/.hermes/plugins/` or `~/.openclaw/plugins/`), writes the initial `config.yaml`, and restarts the agent runtime.

Features: hybrid retrieval (FTS5 + vector), smart dedup, tiered skill evolution (L1 traces / L2 policies / L3 world model), multi-agent collaboration, local-first SQLite storage.

## 🤝 Community

- **GitHub Issues:** [https://github.com/MemTensor/MemOS/issues](https://github.com/MemTensor/MemOS/issues)
- **GitHub Discussions:** [https://github.com/MemTensor/MemOS/discussions](https://github.com/MemTensor/MemOS/discussions)
- **Discord:** [https://discord.gg/Txbx3gebZR](https://discord.gg/Txbx3gebZR)
- **WeChat:** scan the QR code to join the group.

<div align="center">
  <img src="https://statics.memtensor.com.cn/memos/qr-code.png" alt="QR Code" width="300" />
</div>



## 📚 Citation

If you use MemOS in your research, please cite:

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
```



## ⚖️ License

MemOS is licensed under the [Apache 2.0 License](./LICENSE).
