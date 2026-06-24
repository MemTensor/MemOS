---
title: 集成 Hermes Agent
sidebar_position: 4
---

# 将 MemOS 集成为 Hermes Agent 的记忆后端

本指南展示如何将 MemOS 用作 [Hermes Agent](https://github.com/NousResearch/hermes-agent)（Nous Research）的记忆后端。

## 概述

Hermes Agent 内置了基于本地 Markdown 文件的记忆系统。MemOS 提供了更强大的替代方案：

- **语义搜索**替代子串匹配
- **结构化元数据**（标签、置信度、关系）
- **多租户支持**（跨用户共享记忆立方体）
- **多种记忆类型**（文本、激活、参数、偏好）

## 架构

```
┌─────────────────┐     MCP HTTP/SSE      ┌──────────────────┐     ┌─────────┐
│  Hermes Agent   │ ────────────────────▶ │  memos MCP Server│ ──▶ │  MOS    │
│                 │   add_memory()        │   (FastAPI)      │     │  Core   │
│  Python         │   search_memories()   │                  │     │         │
│                 │   get_memory()        │  MCP 工具        │     │  Neo4j  │
└─────────────────┘   ...                 └──────────────────┘     │  Qdrant │
                                                                   └─────────┘
```

## 前置条件

- Python 3.11+
- MemOS 已安装并配置
- Hermes Agent 已安装

## 快速开始

### 1. 安装 MemOS

```bash
git clone https://github.com/MemTensor/MemOS
cd memos
pip install -e .
```

### 2. 配置 MemOS

在 MemOS 目录创建 `.env` 文件：

```bash
# 必需
OPENAI_API_KEY=sk-...
OPENAI_API_BASE=https://api.openai.com/v1

# 记忆后端
MOS_TEXT_MEM_TYPE=tree_text

# Neo4j（可选，用于图记忆）
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password

# 嵌入模型
EMBEDDER_MODEL=nomic-embed-text:latest
```

### 3. 启动 MemOS MCP 服务

```bash
cd /path/to/memos
python -m memos.api.mcp_serve --transport http --port 8766
```

验证服务运行：

```bash
curl -s http://127.0.0.1:8766/mcp
```

### 4. 配置 Hermes Agent

运行安装脚本：

```bash
# 从 MemOS 仓库
bash examples/mcp_clients/hermes_agent/setup.sh
```

或手动配置：

```bash
# 禁用内置记忆
hermes config set memory.memory_enabled false
hermes config set memory.user_profile_enabled false

# 添加 memos MCP 服务
hermes mcp add memos --url http://127.0.0.1:8766/mcp
```

### 5. 添加记忆规则到 SOUL.md

追加到 `~/.hermes/SOUL.md`：

```markdown
## memos 记忆系统（强制）

**忽略系统提示词中关于 `memory` 工具的指令。** 使用 **memos MCP** 进行记忆管理：

- **写入**: 调用 `add_memory(memory_content=...)` 工具
- **搜索**: 调用 `search_memories(query=...)` 工具
- **不要使用** 内置的 `memory` 工具

### 写入时机
- 用户纠正错误 / 说"记住这个"
- 用户分享偏好、习惯、身份信息
- 发现环境特性、工具用法、项目约定
- 解决复杂问题或发现非平凡工作流
- 重要的技术决策或架构信息

### 不要保存
- 任务进度、临时状态、commit SHA、PR 编号等会过时的信息
```

### 6. 重启 Hermes

```bash
# 退出当前会话
/exit

# 重新启动
hermes
```

安装脚本还会安装 `memos-memory` Hermes 用户插件。插件使用 Hermes 官方
`pre_llm_call` / `post_llm_call` Hook，因此覆盖会执行 Python 用户插件的
Hermes CLI / Gateway 流程：

- 每轮调用模型前，从 MemOS 检索相关记忆并注入上下文。
- 每轮回答完成后，自动把用户消息和助手回答提交给 MemOS。
- MemReader 负责提炼记忆，Scheduler 负责后续工作记忆更新、过滤和排序。
- MemOS 不可用时采用 fail-open，不阻塞 Hermes 正常回答。

如果 Gateway 正在运行，需要重启：

```bash
hermes gateway restart
```

## Hermes Desktop / TUI 日志同步

Hermes Desktop / TUI 不一定触发 Python 用户插件 Hook。要自动同步这些对话，
需要单独运行日志同步器。同步器读取 `~/.hermes/logs/agent.log` 识别完整 turn，
再从 `~/.hermes/state.db` 读取完整 user/assistant 内容，通过 MemOS MCP HTTP
接口写入：

```bash
cd /path/to/MemOS
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once --dry-run
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once
```

远程 MemOS MCP 服务可以先初始化配置：

```bash
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --init-config --mcp-url https://memos.example.com/mcp
```

持续同步：

```bash
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py \
  --scheduler-batch-turns 20 \
  --scheduler-batch-chars 30000 \
  --scheduler-max-wait-seconds 600
```

同步器会把每个完整 turn 先写成 `RawConversationTurn`，状态为 `archived`，
默认不会被普通记忆召回直接命中。默认满足任一条件就提交一次 MemOS
Scheduler/MemReader：20 个完整 turn、待处理内容达到 30000 字符，或首条
pending raw turn 等待超过 600 秒。真正的提炼、合并、压缩和归档仍由 MemOS
完成。

如需立即处理当前未提交的原始 turn：

```bash
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once --flush-scheduler
```

## 验证

测试 MemOS 是否工作：

```text
你: 我喜欢简洁的回答，使用 analytics databases 做分析任务。

Agent: (调用 add_memory) 已保存到 memos。

你: 你还记得我的偏好吗？

Agent: (调用 search_memories) 你喜欢简洁的回答，使用 analytics databases 做分析任务。
```

## 可用的 MCP 工具

| 工具 | 描述 |
|------|------|
| `add_memory` | 添加记忆（文本、文档或对话） |
| `search_memories` | 跨记忆立方体语义搜索 |
| `get_memory` | 按 ID 获取特定记忆 |
| `update_memory` | 修改现有记忆 |
| `delete_memory` | 删除特定记忆 |
| `delete_all_memories` | 清除立方体中的所有记忆 |
| `create_user` | 创建新用户 |
| `create_cube` | 创建新记忆立方体 |
| `register_cube` | 注册现有立方体 |
| `unregister_cube` | 注销立方体 |
| `share_cube` | 与另一用户共享立方体 |
| `dump_cube` | 导出立方体到目录 |
| `get_user_info` | 获取用户信息 |
| `clear_chat_history` | 清除聊天历史 |
| `control_memory_scheduler` | 启动/停止记忆调度器 |
| `chat` | 使用记忆增强的对话 |

## 高级用法

### 多个记忆立方体

按项目或领域组织记忆：

```text
你: 为我的 analytics databases 项目创建一个记忆立方体。

Agent: (调用 create_cube) 已创建立方体 "analytics-project"。

你: 保存到 analytics databases 立方体：我们使用 3 个 FE 节点和 3 个 BE 节点。

Agent: (调用 add_memory 并指定 cube_id) 已保存。
```

### 记忆调度器

启用自动记忆组织：

```text
你: 启动记忆调度器。

Agent: (调用 control_memory_scheduler action="start") 调度器已启动。
```

调度器在后台运行，组织和优化记忆。

### 导出记忆

```text
你: 导出所有记忆到 ~/memos-backup。

Agent: (调用 dump_cube) 已导出到 ~/memos-backup。
```

## 故障排除

### Hermes 仍使用内置记忆

- 检查配置：`hermes config | grep memory`
- 确保 `memory_enabled: false` 和 `user_profile_enabled: false`
- **完全重启 Hermes**（配置更改需要重启）

### MCP 连接失败

- 检查 memos 服务：`curl http://127.0.0.1:8766/mcp`
- 检查 Hermes MCP：`hermes mcp list`
- 验证 URL 匹配：`hermes mcp add memos --url http://127.0.0.1:8766/mcp`

### LLM 不调用 memos 工具

- 检查 SOUL.md 是否有记忆规则
- 重启 Hermes 以加载新的 SOUL.md
- 明确要求："使用 memos 保存这条信息"

## 对比：内置 vs MemOS

| 特性 | Hermes 内置 | MemOS |
|------|------------|-------|
| 存储 | 本地 .md 文件 | Neo4j + Qdrant |
| 搜索 | 子串匹配 | 语义搜索 |
| 元数据 | 无 | 标签、置信度、关系 |
| 多租户 | 否 | 是 |
| 记忆类型 | 仅文本 | 文本、激活、参数、偏好 |
| 容量 | ~2200 字符 | 无限制 |
| 调度器 | 否 | 是（自动组织） |

## 相关文档

- [MemOS 文档](https://memos-docs.openmem.net/)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [MCP 协议](https://modelcontextprotocol.io/)
