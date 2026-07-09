

#   MemOS 2.0 Stardust（星尘）

**智能始于记忆**  
**让您的Agent拥有持续记忆与成长能力**  
**为 AI 应用提供可扩展的记忆服务，让模型在跨任务、跨场景中保持一致理解与个性化体验**



[English](README.md) | **中文**

---



## 📊 性能表现

MemOS 在多个评测榜单中处于领先地位——与主流商业记忆产品横向对比，覆盖 5 个用户记忆榜单和 5 个 Agent 记忆任务。


| 榜单              | 分数    |
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


评测框架 OmniMemEval——[https://github.com/MemTensor/OmniMemEval](https://github.com/MemTensor/OmniMemEval)。

## 🎯 MemOS 适用于

MemOS 为 AI agent 提供长期记忆能力，典型场景：

- AI 助手：保持上下文一致的连续对话
- 客服系统：召回历史工单与用户信息，提供针对性帮助
- 个性化 agent：适应用户偏好，持续学习与调整
- 多 agent 协作：共享或隔离的记忆空间

  


## 🚀 快速开始

MemOS 提供三种使用方式，按你的场景选择。


|      | 本地部署              | OpenClaw 云插件             | 本地插件                    |
| ---- | ----------------- | ------------------------ | ----------------------- |
| 适合谁  | 自建基础设施的团队         | OpenClaw 用户，零运维          | Hermes/OpenClaw，100% 端侧 |
| 启动方式 | docker compose up | openclaw plugins install | npm install + 配置        |
| 依赖设施 | Neo4j + Qdrant    | 无（使用 MemOS Cloud）        | 无（本地 SQLite）            |
| 数据存放 | 你的服务器             | MemOS Cloud              | 你的机器                    |




### 🖥️ 本地部署 MemOS 服务

想把 MemOS 作为 REST 服务跑在自己的机器或集群上。

**方式 A — Docker（推荐）：**

```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS
cp docker/.env.example .env          # 在 .env 中填入你的 API key
cd docker
docker compose up                    # 启动 MemOS API + Neo4j + Qdrant
```

API 服务地址：`http://localhost:8000`。

**方式 B — 用 uvicorn 启动（不用 Docker）：**

```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS
cp docker/.env.example .env          # 在 .env 中填入你的 API key
# 确保 Neo4j 和 Qdrant 已启动，然后：
cd src
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8000 --workers 1
```

所有配置项（LLM、embedder、向量库、图库、调度器）见 `[docker/.env.example](./docker/.env.example)`。完整部署指南：[https://memos-docs.openmem.net/open_source/getting_started/rest_api_server/](https://memos-docs.openmem.net/open_source/getting_started/rest_api_server/)。

**试用 API：**

```python
import requests, json

headers = {"Content-Type": "application/json"}
base = "http://localhost:8000/product"

# 1. 创建记忆 cube
requests.post(f"{base}/create_cube", headers=headers, data=json.dumps({
    "cube_name": "Alice's memory",
    "owner_id": "alice",
    "cube_id": "alice_cube",
}))

# 2. 写入一条记忆
requests.post(f"{base}/add", headers=headers, data=json.dumps({
    "user_id": "alice",
    "writable_cube_ids": ["alice_cube"],
    "messages": [{"role": "user", "content": "I like strawberry"}],
    "async_mode": "sync",
}))

# 3. 检索记忆
res = requests.post(f"{base}/search", headers=headers, data=json.dumps({
    "query": "What do I like?",
    "user_id": "alice",
    "readable_cube_ids": ["alice_cube"],
}))
print(res.json())
```



### 🧠 MemOS 插件：为你的 AI agent 提供持久记忆 ✨

你的 OpenClaw 和 Hermes Agent 现在拥有**最佳**记忆系统——选择***云服务***或***自部署***即可开始 🏃🏻


| 🔌 插件                                                                                                 | 💡 核心特性 | 🧩 资源                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🧠 **[memos-local-plugin 2.0](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)** |         | 🌐 [官网](https://memos-claw.openmem.net/) · 📖 [文档](https://memos-docs.openmem.net/cn/openclaw/local_plugin) · 🐙 [GitHub](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) · 📦 [NPM](https://www.npmjs.com/package/@memtensor/memos-local-plugin) |
| ☁️ **[OpenClaw 云插件](https://github.com/MemTensor/MemOS/tree/main/apps/MemOS-Cloud-OpenClaw-Plugin)**  |         | 🖥️ [MemOS 控制台](https://memos-dashboard.openmem.net/login/) · 📖 [完整教程](https://memos-docs.openmem.net/openclaw/guide#_4-update-plugin)                                                                                                                                 |




#### 1. OpenClaw 云插件

使用 OpenClaw，想通过 MemOS Cloud 获得持久记忆——无需自建基础设施。

- **仓库：** [MemTensor/MemOS ·](https://github.com/MemTensor/MemOS/tree/main/apps/MemOS-Cloud-OpenClaw-Plugin) `apps/MemOS-Cloud-OpenClaw-Plugin`
- **NPM：** `[@memtensor/memos-cloud-openclaw-plugin](https://www.npmjs.com/package/@memtensor/memos-cloud-openclaw-plugin)`
- **控制台：** [https://memos-dashboard.openmem.net/](https://memos-dashboard.openmem.net/)
- **教程：** [https://memos-docs.openmem.net/openclaw/guide](https://memos-docs.openmem.net/openclaw/guide)

安装：

```bash
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

插件在每次 agent 运行前从 MemOS Cloud 召回记忆，运行结束后把新消息写回。

#### 2. 本地插件（memos-local-plugin 2.0）

使用 Hermes Agent 或 OpenClaw，想要 100% 端侧记忆——数据不离开本机。

- **仓库：** [MemTensor/MemOS ·](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) `apps/memos-local-plugin`
- **NPM：** `[@memtensor/memos-local-plugin](https://www.npmjs.com/package/@memtensor/memos-local-plugin)`
- **文档：** [https://memos-docs.openmem.net/cn/openclaw/local_plugin](https://memos-docs.openmem.net/cn/openclaw/local_plugin)
- **查看器面板：** 见 `apps/memos-local-plugin/viewer/`

特性：混合检索（FTS5 + 向量）、智能去重、分层技能演化（L1 轨迹 / L2 策略 / L3 世界模型）、多 agent 协作、本地优先 SQLite 存储。

## 🤝 社区

- **GitHub Issues：** [https://github.com/MemTensor/MemOS/issues](https://github.com/MemTensor/MemOS/issues)
- **GitHub Discussions：** [https://github.com/MemTensor/MemOS/discussions](https://github.com/MemTensor/MemOS/discussions)
- **Discord：** [https://discord.gg/Txbx3gebZR](https://discord.gg/Txbx3gebZR)
- **微信：** 扫码加入微信群。



## 📚 引用

如果在研究中使用 MemOS，请引用：

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



## ⚖️ 许可证

MemOS 基于 [Apache 2.0 许可证](./LICENSE) 开源。