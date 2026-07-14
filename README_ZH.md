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
    <strong>让 Agent 拥有持续记忆与成长能力</strong><br/>
  </p>

  <p align="center">
    <a href="README.md">English</a> | <strong>中文</strong>
  </p>
</div>


<div align="center">
  <img width="1660" height="664" alt="MemOS Plugin Banner" src="https://github.com/user-attachments/assets/9d15dde2-196e-4f71-a364-dd5a33062117" />
</div>

---

## 👾 MemOS：面向 LLM 与 AI Agent 的记忆操作系统

**MemOS** 是一个面向 LLM 与 AI Agent 的记忆操作系统，统一了长期记忆的**存/取/管**，内置 **KB**、**多模态**、**工具记忆** 与 **企业级** 优化，实现上下文感知与个性化的交互。

### 核心特性

- **统一记忆 API**：用单一 API 完成记忆的增、删、改、查——以图结构组织，可检视、可编辑，不是黑盒向量库。
- **多模态记忆**：原生支持文本、图像、工具轨迹与人格，在同一记忆系统中统一检索与推理。
- **多 Cube 知识库管理**：将多个知识库组合为可复用的记忆 Cube，实现跨用户、项目与 Agent 的隔离、受控共享与动态组合。
- **MemScheduler 异步写入**：以异步方式执行记忆操作，毫秒级延迟，保障高并发下的生产稳定性。
- **记忆反馈与修正**：通过自然语言反馈精炼记忆——可纠正、补充或替换已有记忆，持续演进。

### News

- **2026-07-02** · 🏆 **MemOS 在 Agent 与用户记忆榜单上全面领先**
  在 MemOS 的加持下，**OpenClaw** 在五个 Agent 任务上的平均任务完成率从 **36.63% 提升到 50.87%**。MemOS 在 **LoCoMo** 取得 **88.83**、**LongMemEval** 取得 **89.20**，并在 **OmniMemEval**（覆盖 14 款商业记忆产品、十个数据集的统一评测）中领先。

- **2026-05-09** · 🧠 **memos-local-plugin 2.0**
  **Hermes Agent** 与 **OpenClaw** 官方本地记忆插件。单一核心驱动自演化记忆：L1 轨迹、L2 策略、L3 世界模型与结晶化 Skill，本地优先存储 + 反馈驱动检索。

- **2026-04-10** · 👧🏻 **MemOS Hermes Agent 本地插件**
  官方 Hermes Agent 记忆插件发布：混合检索（FTS5 + 向量）、智能去重、分层技能演化、多 Agent 协作。100% 本地，零云依赖。

- **2026-03-08** · 🦞 **MemOS OpenClaw 插件——云端与本地**
  官方 OpenClaw 记忆插件发布。**云插件**：托管记忆服务，token 用量降低 72%，支持多 Agent 记忆共享（[MemOS-Cloud-OpenClaw-Plugin](https://github.com/MemTensor/MemOS-Cloud-OpenClaw-Plugin)）。**本地插件**（`v1.0.0`）：100% 端侧记忆，持久化 SQLite，混合检索（FTS5 + 向量），任务摘要与技能演化，多 Agent 协作，配套完整记忆查看器面板。



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

MemOS 提供四种使用方式，按你的场景选择。


|      | Cloud API    | 本地部署              | OpenClaw 云插件             | 本地插件                    |
| ---- | ------------ | ----------------- | ------------------------ | ----------------------- |
| 适合谁  | 自建应用，全托管      | 自建基础设施的团队         | OpenClaw 用户，零运维          | Hermes/OpenClaw，100% 端侧 |
| 启动方式 | 申请 API Key   | docker compose up | openclaw plugins install | npm install + 配置        |
| 依赖设施 | 无（托管）        | Neo4j + Qdrant    | 无（使用 MemOS Cloud）        | 无（本地 SQLite）            |
| 数据存放 | MemOS Cloud  | 你的服务器             | MemOS Cloud              | 你的机器                    |

### ☁️ 使用 Cloud API（托管）

想通过全托管服务给应用加记忆——无需自建任何基础设施。

**1. 申请 API Key：**

- 在 [MemOS 控制台](https://memos-dashboard.openmem.net/cn/quickstart/?source=landing) 注册。
- 进入 **API Keys** 复制你的 Key（以 `mpg-` 开头），请妥善保存在服务端。

**2. 写入与检索记忆：**

```python
import requests

API_KEY = "mpg-..."                  # 请保存在服务端
base = "https://memos.memtensor.cn/api/openmem/v1"
headers = {"Authorization": f"Token {API_KEY}", "Content-Type": "application/json"}

# 1. 写入一条记忆
requests.post(f"{base}/add/message", headers=headers, json={
    "user_id": "alice",
    "conversation_id": "conv_001",
    "messages": [{"role": "user", "content": "I like strawberry"}],
})

# 2. 检索记忆
res = requests.post(f"{base}/search/memory", headers=headers, json={
    "query": "What do I like?",
    "user_id": "alice",
})
print(res.json())
```

**下一步：**

- [MemOS Cloud 快速开始](https://memos-docs.openmem.net/memos_cloud/quick_start/)——几分钟内接入 MemOS Cloud 并启用记忆。
- [MemOS Cloud 平台](https://memos.openmem.net/?from=/quickstart/)——探索云端控制台、功能与工作流。

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

安装（macOS / Linux）：

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh | bash
```

安装（Windows PowerShell）：

```powershell
irm https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.ps1 -OutFile "$env:TEMP\memos-install.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\memos-install.ps1"
```

需先安装 Node.js，且已安装 OpenClaw 或 Hermes。安装器会自动识别 OpenClaw 与 Hermes，将插件部署到对应的 agent 主目录（`~/.hermes/plugins/` 或 `~/.openclaw/plugins/`），写入初始 `config.yaml`，并按需重启 agent 运行时。

特性：混合检索（FTS5 + 向量）、智能去重、分层技能演化（L1 轨迹 / L2 策略 / L3 世界模型）、多 agent 协作、本地优先 SQLite 存储。

## 🤝 社区

- **GitHub Issues：** [https://github.com/MemTensor/MemOS/issues](https://github.com/MemTensor/MemOS/issues)
- **GitHub Discussions：** [https://github.com/MemTensor/MemOS/discussions](https://github.com/MemTensor/MemOS/discussions)
- **Discord：** [https://discord.gg/Txbx3gebZR](https://discord.gg/Txbx3gebZR)
- **微信：** 扫码加入微信群。

<div align="center">
  <img src="https://statics.memtensor.com.cn/memos/qr-code.png" alt="QR Code" width="300" />
</div>



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