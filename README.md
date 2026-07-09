

#   MemOS 2.0 Stardust（星尘）

**Intelligence begins with memory.**  
**Give your Agent persistent memory and the ability to grow.**  
**Scalable memory services for AI applications — keeping models consistent and personalized across tasks and scenarios.**



**English** | [中文](README_ZH.md)

---

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

MemOS is built around three entry points. Pick the one that matches your scenario.


|              | Self-Host          | OpenClaw Cloud Plugin    | Local Plugin                    |
| ------------ | ------------------ | ------------------------ | ------------------------------- |
| Best for     | Teams on own infra | OpenClaw users, zero ops | Hermes/OpenClaw, 100% on-device |
| Setup        | docker compose up  | openclaw plugins install | npm install + config            |
| Infra needed | Neo4j + Qdrant     | None (uses MemOS Cloud)  | None (local SQLite)             |
| Data lives   | Your servers       | MemOS Cloud              | Your machine                    |

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

Features: hybrid retrieval (FTS5 + vector), smart dedup, tiered skill evolution (L1 traces / L2 policies / L3 world model), multi-agent collaboration, local-first SQLite storage.

## 🤝 Community

- **GitHub Issues:** [https://github.com/MemTensor/MemOS/issues](https://github.com/MemTensor/MemOS/issues)
- **GitHub Discussions:** [https://github.com/MemTensor/MemOS/discussions](https://github.com/MemTensor/MemOS/discussions)
- **Discord:** [https://discord.gg/Txbx3gebZR](https://discord.gg/Txbx3gebZR)
- **WeChat:** scan the QR code to join the group.



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
