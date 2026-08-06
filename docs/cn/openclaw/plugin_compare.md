---
title: 云插件 vs 本地插件
desc: 云插件面向快速接入 MemOS Cloud，本地插件面向 OpenClaw 与 Hermes 的本机长期记忆和自进化能力。本文将帮你快速理解两者差异，选择最适合自己的方案。
---

## 插件简介

### 云插件

将记忆托管于 **MemOS Cloud**。安装 OpenClaw 云插件后，只需配置一个 MemOS Cloud API Key 即可使用，支持多 Agent 跨设备共享记忆，经基准测试可降低约 **72% 的 Token 消耗**，适合快速上手、跨设备协作和生产环境接入。

### 本地插件

新版本地插件为 `@memtensor/memos-local-plugin`，是一套 **OpenClaw 与 Hermes 共用的本地优先记忆核心**。它把数据写入本机 SQLite，并沉淀为 L1 Trace、L2 Policy、L3 World Model 与可调用 Skill 四层记忆；同时通过反馈驱动自进化、三层检索和决策修复，让 Agent 在本机逐步积累可复用经验。适合对隐私、安全、本地化运行或可观测性有更高要求的开发者。

---

## 核心区别

| 对比维度 | ☁️&nbsp;MemOS&nbsp;云插件 | 🖥️&nbsp;MemOS&nbsp;本地插件 |
| --- | --- | --- |
| 💾&nbsp;**数据存储与隐私** | **云端存储**：记忆数据存储在 MemOS Cloud，便于跨设备、多实例共享。 | **本地存储**：每个 Agent 拥有独立运行目录，OpenClaw 默认在 `~/.openclaw/memos-plugin/`，Hermes 默认在 `~/.hermes/memos-plugin/`。SQLite、Skill 包、日志和配置都保留在本机。 |
| 🤖&nbsp;**Agent 支持** | 面向 OpenClaw 云插件，依托 MemOS Cloud 提供统一记忆服务。 | 同一套核心支持 OpenClaw 与 Hermes：OpenClaw 通过 TypeScript 插件进程内集成，Hermes 通过 Python Provider + JSON-RPC 桥接到 Node 核心。 |
| 🔑&nbsp;**API 与模型配置** | 使用 MemOS Cloud API Key，由云端承担记忆处理、检索和演进。 | 通过 Memory Viewer 的 Settings 面板配置模型与团队共享。Embedding 默认可使用本地 provider，也可配置 OpenAI-compatible、Gemini、Cohere、Voyage、Mistral；OpenClaw 可继承宿主模型，Hermes 可在面板中配置 LLM provider 与 API Key。 |
| 🔍&nbsp;**检索能力** | 云端语义向量检索 + 图检索，由服务端统一优化。 | 三层检索：Tier 1 Skill、Tier 2 Trace/Episode、Tier 3 World Model；同时融合向量、FTS5、关键词 pattern 与错误特征等通道，并通过 RRF + MMR 控制相关性和多样性。 |
| 🧠&nbsp;**记忆进化** | 由云端服务自动完成：对写入记忆进行结构化处理、去冗余与自然语言纠错。 | Reflect2Evolve 本地流水线：对话与工具调用沉淀为 L1 Trace，跨任务归纳为 L2 Policy，再抽象为 L3 World Model；高价值策略会结晶为可调用 Skill，并根据反馈进入 active / retired 等生命周期。 |
| 🛠️&nbsp;**决策修复** | 主要依赖云端召回更相关的历史记忆，降低重复上下文和无效 Token。 | 工具失败、负反馈和任务结果会进入反馈通道；失败模式可触发 decision repair，在下一轮注入纠偏上下文，帮助 Agent 避免重复踩坑。 |
| 👥&nbsp;**多 Agent 与共享** | 支持多 Agent 场景和跨设备共享，适合团队协作。 | 默认按 Agent 隔离：OpenClaw 与 Hermes 拥有各自数据库和 Viewer。可选开启 Hub，在局域网 / VPN 内共享本地结晶的 Skill 和可选 Trace 摘要；共享不在算法关键路径上，失败会自动退化为本地模式。 |
| 👀&nbsp;**可视化与可观测性** | 通过 MemOS Cloud Dashboard 管理 API Key 和云端记忆能力。 | 内置本地 Viewer：Overview、Memories、Tasks、Policies、World Models、Skills、Analytics、Logs、Import、Settings、Help 等页面；HTTP + SSE 实时展示事件、日志、检索、Skill 和健康状态。 |
| 🛠️&nbsp;**部署与配置** | **极简**：三步完成（安装插件、获取 API Key、配置环境变量），主要依赖云服务。 | **极简**：安装与升级都是一行命令。安装器会自动检测系统中已安装的 OpenClaw / Hermes，安装 `@memtensor/memos-local-plugin`、创建运行目录并重启对应运行时。 |

---

## 安装速览

### 云插件（3 步完成）

1. **安装插件**
    ```bash
    openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
    ```

2. **获取并配置 API Key**

    获取 API Key：[MemOS Cloud Dashboard](https://memos-dashboard.openmem.net/cn/apikeys/)

    ```bash
    mkdir -p ~/.openclaw && echo "MEMOS_API_KEY=mpg-..." > ~/.openclaw/.env
    ```

3. **重启 gateway**

    ```bash
    openclaw gateway restart
    ```

**手动更新插件**：
```bash
openclaw plugins update @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

> 更多信息请参考 [Openclaw 云插件文档](/cn/openclaw/guide#快速开始)

### 本地插件（一行命令）

```bash
# 安装插件
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh | bash
```

安装与升级使用同一条命令。安装器会自动检测本机是否安装 OpenClaw / Hermes。交互式终端会询问安装到哪个 Agent，非交互环境会自动安装到检测到的 Agent。

| Agent | 代码目录 | 数据与配置目录 | Viewer |
| --- | --- | --- | --- |
| OpenClaw | `~/.openclaw/plugins/memos-local-plugin/` | `~/.openclaw/memos-plugin/` | `http://127.0.0.1:18799` |
| Hermes | `~/.hermes/plugins/memos-local-plugin/` | `~/.hermes/memos-plugin/` | `http://127.0.0.1:18800` |

> 升级或卸载插件代码不会删除已有本地数据、技能包或日志。OpenClaw 与 Hermes 各自运行独立 Viewer，没有共享端口或只读 peer 视图。
>
> 模型、团队共享和常规选项都在对应 Agent 的 Memory Viewer 里配置：OpenClaw 默认 `http://127.0.0.1:18799`，Hermes 默认 `http://127.0.0.1:18800`。
