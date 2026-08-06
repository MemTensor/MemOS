---
title: 本地插件使用
desc: MemOS 本地插件在 OpenClaw 与 Hermes 中的基础使用、工具调用、团队共享和多 Agent 场景示例。
---

## 基本使用

`@memtensor/memos-local-plugin` 同时支持 OpenClaw 与 Hermes。安装完成后，按你使用的 Agent 正常启动即可；插件会在每轮任务开始前注入本地记忆上下文，并在任务结束后写入 Trace、Policy、World Model 和 Skill。

| Agent | 启动方式 | Viewer |
| --- | --- | --- |
| OpenClaw | 正常启动或重启 OpenClaw gateway | `http://127.0.0.1:18799` |
| Hermes | `hermes chat` | `http://127.0.0.1:18800` |

### 验证记忆功能

1. 与 OpenClaw 或 Hermes Agent 进行任意对话。
2. 打开对应 Memory Viewer，确认对话内容已出现在 **Memories** / **Tasks** 页面。
3. 新开一个对话，让 Agent 回忆之前的内容：

```text
你：你还记得我之前让你帮我处理过什么事情吗？
Agent：（调用 memory_search）是的，我们之前讨论过……
```

---

## 记忆工具

本地插件会通过各自 Agent 宿主暴露记忆工具。不同宿主展示名称可能略有差异，但核心能力一致。

| 工具 | 说明 |
| --- | --- |
| `memory_search` | 从 Skill、Trace/Episode、World Model 三层检索相关上下文。 |
| `memory_get` | 获取某条记忆详情。 |
| `memory_timeline` | 查看某个 episode / task 附近的时间线。 |
| `skill_list` | 列出当前可用 Skill。 |
| `skill_get` | 获取某个 Skill 的调用指南。 |
| `memory_environment` | 查询 L3 World Model，了解项目结构、环境规律和约束。 |

### 调用示例

```text
Agent 调用:
  memory_search("Nginx 部署配置")
  → 返回相关 Skill、Trace 片段和环境认知

Agent 调用:
  skill_get("nginx-proxy")
  → 返回可执行步骤、适用条件和注意事项
```

插件也会记录工具调用成功 / 失败结果，用于后续 decision repair。

---

## 团队共享

默认情况下，OpenClaw 与 Hermes 各自使用独立本地数据库。需要协作时，可以在 Memory Viewer 中启用 Team Sharing，把本地结晶出的 Skill 和可选 Trace 摘要共享给同一局域网 / VPN 内的其他实例。

### 配置方式

打开对应 Agent 的 Memory Viewer，进入 **Settings → Team Sharing**，按面板提示填写团队地址和 token，保存后插件会自动重启并加载设置。

### 预期效果

- 私有本地数据默认留在当前 Agent 的运行目录中。
- 明确共享的 Skill 可被其他实例检索和复用。
- Hub 不在算法关键路径上；共享失败时，本地记忆写入、召回和 Skill 检索仍可继续。

---

## 多 Agent 场景

同一台机器上同时安装 OpenClaw 和 Hermes 时，它们的端口和数据完全隔离：

| 资源 | OpenClaw | Hermes |
| --- | --- | --- |
| Viewer | `18799` | `18800` |
| 数据目录 | `~/.openclaw/memos-plugin/` | `~/.hermes/memos-plugin/` |
| 配置入口 | Viewer → Settings | Viewer → Settings |

```text
OpenClaw:
  memory_search("deploy config")
  → 优先使用 OpenClaw 本地经验

Hermes:
  memory_search("deploy config")
  → 优先使用 Hermes 本地经验

开启 Hub 后:
  两者可以显式复用团队共享 Skill
```

---

## Viewer 管理

Memory Viewer 提供这些常用入口：

| 页面 | 用途 |
| --- | --- |
| Overview | 查看核心状态、版本、事件流和健康状态。 |
| Memories | 查看 L1 Trace 和原始执行记录。 |
| Tasks | 查看按任务聚合的对话与执行结果。 |
| Policies | 查看从多个 Trace 归纳出的策略。 |
| World Models | 查看环境认知与约束。 |
| Skills | 查看、检索或停用结晶出的 Skill。 |
| Import | 导入旧版插件数据、OpenClaw 会话 JSONL、Hermes `MEMORY.md`，或导入 / 导出 JSON 备份。 |
| Settings | 配置模型、团队共享、日志和 telemetry。 |
| Help | 查看 `V`、`α`、`R_human`、`η`、support、gain 等字段含义。 |
