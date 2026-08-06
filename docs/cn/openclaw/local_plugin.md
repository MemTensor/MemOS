---
title: 本地插件
desc: 使用 @memtensor/memos-local-plugin 为 OpenClaw 与 Hermes Agent 提供本地优先的长期记忆、三层检索、技能结晶和可观测管理面板。
---

`@memtensor/memos-local-plugin` 是 MemOS 新一代本地插件：一套本地优先的记忆核心，同时适配 **OpenClaw** 与 **Hermes Agent**。它不会把记忆数据托管到云端，而是在你的机器上维护 SQLite 数据库、技能包和日志，让 Agent 在本地持续积累可复用经验。

如果你只想为 OpenClaw 快速接入云端托管记忆，请查看 [OpenClaw 云插件](/cn/openclaw/guide)。如果你更看重隐私、本机运行、可观测性，或希望 OpenClaw / Hermes 都使用同一套本地记忆能力，请使用本页面的本地插件。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 本地优先 | OpenClaw 与 Hermes 各自拥有独立运行目录，SQLite、Skill、日志和配置都保留在本机。 |
| 双 Agent 适配 | OpenClaw 通过 TypeScript 插件进程内接入；Hermes 通过 Python Provider + JSON-RPC 桥接到同一套 Node.js 记忆核心。 |
| 四层记忆 | L1 Trace 记录每一步执行，L2 Policy 归纳跨任务策略，L3 World Model 压缩环境认知，Skill 将高价值经验结晶为可调用能力。 |
| 三层检索 | 按 Skill → Trace/Episode → World Model 检索，并融合向量、FTS5、关键词 pattern 与错误特征，使用 RRF + MMR 控制相关性和多样性。 |
| 反馈驱动进化 | 工具结果、环境反馈、用户显式反馈会更新记忆价值，推动策略归纳、技能结晶和 decision repair。 |
| 本地 Viewer | 提供 Overview、Memories、Tasks、Policies、World Models、Skills、Analytics、Logs、Import、Settings、Help 等页面。 |
| 导入与迁移 | 支持 JSON 导入导出、旧版插件数据迁移，以及按当前 Agent 导入 OpenClaw 会话 JSONL 或 Hermes `MEMORY.md`。 |
| 可选团队共享 | 默认完全隔离；如需协作，可在 Memory Viewer 的 Team Sharing 面板中开启局域网 / VPN 内 Skill 和可选 Trace 摘要共享。 |

## 工作原理

插件在每轮任务开始前检索相关上下文，并把结果注入给 Agent；任务结束后，它会把对话、工具调用、观察结果和反馈写入本地流水线。高价值模式会从原始 Trace 逐步沉淀为 Policy、World Model 和可调用 Skill。下次遇到相似任务时，Agent 可以直接得到“该怎么做”和“哪些坑要避开”的上下文。

| 阶段 | 发生了什么 | 产物 |
| --- | --- | --- |
| 1. Agent 适配 | OpenClaw / Hermes 通过各自 Adapter 把会话、工具调用和反馈交给统一的 `MemoryCore`。 | 标准化的 turn、tool outcome、feedback |
| 2. 本地写入 | `MemoryCore` 把执行过程拆成可追溯的步骤记录。 | L1 Trace |
| 3. 经验归纳 | 多个相似 Trace 会归纳为跨任务策略，并进一步压缩为环境认知。 | L2 Policy、L3 World Model |
| 4. 技能结晶 | 高价值策略会生成可调用 Skill，并根据后续反馈更新可靠性。 | Skill、η、生命周期状态 |
| 5. 检索注入 | 下一轮任务开始前，Retriever 从 Skill、Trace/Episode、World Model 三层召回上下文。 | 注入给 Agent 的本地记忆上下文 |

## 快速开始

### Step 1：一行命令安装或升级

安装与升级使用同一条命令。当前安装脚本面向 macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh | bash
```

安装器会自动检测系统中是否已安装 OpenClaw / Hermes。交互式终端会询问安装到哪个 Agent；非交互环境会自动安装到检测到的 Agent。安装器会部署插件代码、安装生产依赖，并在需要时重启对应运行时。

> 不建议直接 `npm install` 这个包。安装脚本会处理 Agent 检测、目录布局、配置初始化和运行时重启。

### Step 2：打开 Memory Viewer

安装完成后，打开对应的 Memory Viewer：

| Agent | Memory Viewer |
| --- | --- |
| OpenClaw | `http://127.0.0.1:18799` |
| Hermes | `http://127.0.0.1:18800` |

如果你同时安装了 OpenClaw 和 Hermes，它们会使用各自独立的 Viewer 和本地数据目录。

### Step 3：在面板里完成配置

所有用户可见配置都从 Memory Viewer 修改：

- **Settings → AI Models**：配置 Embedding、LLM、Skill Evolver，并用 Test 按钮确认可用。
- **Settings → Team Sharing**：开启或关闭团队共享，配置团队地址与 token。
- **Settings → General**：配置语言、日志详细程度、匿名 telemetry 等。

保存后，Viewer 会自动重启插件并加载新设置。

### Step 4：启动对应 Agent

安装完成后，按你选择的 Agent 正常启动即可。插件会在 Agent 构建 prompt 前检索本地上下文，并在本轮任务结束后把对话、工具调用、观察结果和反馈写入本地记忆。

| Agent | 启动方式 | 插件接入方式 |
| --- | --- | --- |
| OpenClaw | 正常启动或重启 OpenClaw gateway | TypeScript 插件在 OpenClaw 进程内调用 `MemoryCore` |
| Hermes | 运行 `hermes chat` | Python Provider 通过 JSON-RPC 调用 Node.js 记忆核心 |

如果 Hermes 所在机器无法运行 Node.js，Hermes Provider 会报告不可用，并回退到 Hermes 自身的内存模式。

### Step 5：验证记忆功能

回到 Memory Viewer，建议检查以下页面：

1. **Overview**：确认核心状态、版本、事件流正常。
2. **Memories**：确认对话和工具步骤被写入为 Trace。
3. **Tasks / Policies / World Models / Skills**：查看经验如何逐步归纳和结晶。
4. **Import**：导入旧版数据、OpenClaw 会话 JSONL、Hermes `MEMORY.md`，或导入 / 导出 JSON 备份。
5. **Help**：查看每个字段含义，例如 `V`、`α`、`R_human`、`η`、support、gain 等。

## Agent 差异

| 项目 | OpenClaw | Hermes |
| --- | --- | --- |
| 接入方式 | TypeScript 插件，进程内调用 `MemoryCore` | Python `MemoryProvider`，通过 stdio JSON-RPC 调用 Node bridge |
| 默认 Viewer | `http://127.0.0.1:18799` | `http://127.0.0.1:18800` |
| 模型配置 | 在 OpenClaw Viewer 的 Settings → AI Models 中配置 | 在 Hermes Viewer 的 Settings → AI Models 中配置 |
| 数据共享 | 默认与 Hermes 隔离 | 默认与 OpenClaw 隔离 |

两个 Agent 即使安装在同一台机器上，也会使用各自的数据库和 Viewer。只有显式开启 `hub:` 后，才会进行团队共享。

## 可用工具

OpenClaw 与 Hermes 会通过各自宿主暴露记忆工具，常见能力包括：

| 工具 | 用途 |
| --- | --- |
| `memory_search` | 按查询检索相关 Skill、Trace/Episode、World Model。 |
| `memory_get` | 获取某条记忆详情。 |
| `memory_timeline` | 查看某个 episode / task 的时间线。 |
| `skill_list` | 列出可调用 Skill。 |
| `skill_get` | 获取某个 Skill 的调用指南。 |
| `memory_environment` | 查询 L3 World Model，了解项目结构、环境规律和约束。 |

插件也会记录工具调用成功 / 失败结果，用于后续 decision repair。

## 数据管理

- **备份**：在 Viewer 的 Import 页面导出 JSON，或备份当前 Agent 的 `~/.<agent>/memos-plugin/` 目录。
- **仅清空记忆**：在确认已备份后删除运行目录下的 `data/` 和 `skills/`。
- **清空日志**：删除 `logs/` 下普通日志。`audit.log` 会按月 gzip 保留。
- **彻底重置**：删除整个 `~/.<agent>/memos-plugin/`，下次启动会重新创建空目录。

## 更多资料

- [MemOS 本地插件项目](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
- [云插件 vs 本地插件](/cn/openclaw/plugin_compare)
