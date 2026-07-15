---
title: 多智能体记忆隔离
---
## 云插件

MemOS Openclaw 云插件支持多个 Agent 之间完全隔离记忆和和消息历史。每个 Agent 都只能看到自己的记忆，不会串台。

### 如何使用

只需简单配置，即可让不同 Agent 拥有独立的记忆空间。支持自动识别和静态指定两种模式。

#### 1. 开启多 Agent 模式

在 `openclaw.json` 配置中添加：

```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": {
        "config": {
          "multiAgentMode": true
        }
      }
    }
  }
}
```

或设置环境变量：

```bash
MEMOS_MULTI_AGENT_MODE=true
```

#### 2. 自动识别 Agent

开启后，插件会自动读取 `ctx.agentId` ，不同 Agent 的记忆自动隔离。无需额外配置。

#### 3. 静态指定 Agent（可选）

如果需要固定某个 Agent ID，可以在配置中指定：

```json
{
  "config": {
    "agentId": "marketing_agent"
  }
}
```

### 原理介绍

- **/search/memory**：检索记忆——只返回当前 Agent 的记忆
- **/add/message**：添加记录——自动标记为当前 Agent 的数据
- **向下兼容**：默认 Agent `"main"` 会被忽略，保证老用户的单 Agent 数据不受影响

### 适用场景

- **多角色协作**：战略/业务/营销/技术 Agent 分工协作
- **业务线独立**：不同业务线的 Agent 独立运行互不干扰
- **人设一致性**：保持 Agent 长期人设和行为风格一致

---

## 本地插件

`@memtensor/memos-local-plugin` 同时支持 OpenClaw 与 Hermes。默认情况下，每个 Agent 使用独立运行目录和本地数据库；如果在同一套运行目录内区分多个会话 / Agent，检索会优先限定在当前 Agent 的上下文中。需要跨实例协作时，可以在 Memory Viewer 的 **Settings → Team Sharing** 中开启团队共享。

### 规则

- **默认隔离**：OpenClaw 使用 `~/.openclaw/memos-plugin/`，Hermes 使用 `~/.hermes/memos-plugin/`，两者不会自动共享数据库。
- **当前 Agent 优先**：检索时优先使用当前 Agent / session 的 Trace、Policy、World Model 和 Skill。
- **可选共享**：开启 `hub.enabled` 后，可在局域网 / VPN 内共享本地结晶的 Skill 和可选 Trace 摘要。
- **失败降级**：Hub 不在算法关键路径上；共享服务不可用时，本地插件自动退回本机记忆模式。

### 操作示例

```text
OpenClaw:
  memory_search("deploy config")
  → 优先检索 OpenClaw 本地库中的 Skill / Trace / World Model

Hermes:
  memory_search("deploy config")
  → 优先检索 Hermes 本地库中的 Skill / Trace / World Model

开启 Hub 后:
  OpenClaw / Hermes 可以拉取团队共享 Skill
  私有 Trace 默认仍留在各自机器和运行目录中
```

### 预期结果

- OpenClaw 与 Hermes 默认互不读取对方的本地数据库
- 同一团队内可显式共享高价值 Skill，减少重复踩坑
- 即使 Hub 不可用，本地记忆写入、召回和技能检索仍然可用
