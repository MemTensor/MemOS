---
title: OpenClaw 云插件
desc: 增强 OpenClaw 的记忆能力并减少 72% 的 Token 消耗：MemOS OpenClaw 插件现已上线！
---

OpenClaw 近期备受关注，但在实际使用中，用户普遍会遇到两个难以回避的问题：

1. **Token 消耗过快**：OpenClaw 能处理许多长尾任务，但每次运行都会消耗大量 Token。当你让它监控屏幕、运行定时任务或处理复杂工作流时，Token 消耗更是惊人。

    > <b>("你知道 Token 就是金钱🫠")</b>

2. **记忆功能薄弱**：虽然很多人声称 OpenClaw 的记忆能力超越 ChatGPT，但实践中你会发现它虽然能记住一些信息，却往往不是你需要的关键信息。重要偏好可能被遗忘，而无关紧要的闲聊却被记得一清二楚。

    > <b>("能不能请你记住一些对我真正重要的事情？？？")</b>

::tip
**这不是 OpenClaw 的错，所有 AI Agent 都面临这些挑战。**
::

本教程将指导你通过 MemOS OpenClaw 插件解决这 3 个核心痛点：
- **显著降低 Token 消耗** — 智能检索相关记忆，而非无差别加载全部历史
- **让记忆真正有用** — 专业级记忆分类与管理，记住该记的，遗忘该忘的
- **保留 OpenClaw 的核心优势** — 跨设备控制、主动交互、类人体验保持不变

---

## 为什么 OpenClaw 成了"Token 杀手"🥷？

### OpenClaw 的问题

```plaintext
第 1 次对话: 500 tokens
第 2 次对话: 500 + 800 = 1,300 tokens
第 3 次对话: 1,300 + 600 = 1,900 tokens
第 10 次对话: 10,000+ tokens
```

当你让 OpenClaw 监控屏幕、执行定时任务并按计划运行时，这个数字增长得更快。

### OpenClaw 原生记忆管理的三个关键缺陷

OpenClaw 的记忆存储在本地 `.md` 文件中，分为全局记忆和每日记忆。虽然听起来不错，但实际使用中存在三个不可避免的问题：

#### 1. 全局记忆膨胀失控
随着全局记忆不断累积，上下文超载随之而来。更糟糕的是，这些记忆会持续干扰当前对话——你可能只想问一个简单的问题，它却把三个月前的每一句话都翻出来。

#### 2. 每日记忆检索困难
每日记忆不断累积，使检索变得繁琐。要回忆昨天的活动，你必须经历额外的检索过程。维护跨会话记忆几乎变得不可能。

#### 3. 记忆依赖模型的主动记录
OpenClaw 的记忆系统依赖模型自身记录信息，而非自动记录。这意味着它经常遗漏细节——你提到某件事，它马上就忘了。

> 我自己就遇到过好几次：我明确强调了某个项目配置，但第二天重启对话时，它完全没有印象，需要我重新解释一遍。

---

## OpenClaw vs OpenClaw + MemOS：记忆方案对比

### OpenClaw 原生记忆方案

#### 记忆存储方案

**核心哲学：文件即真理** — 摒弃不透明的向量数据库，选择 Markdown 文件作为记忆的核心载体。

![OpenClaw记忆方案](https://cdn.memtensor.com.cn/img/1772698365666_utw5a2_compressed.png)

#### 记忆检索方案：双引擎驱动

| 引擎 | 技术 | 特点 |
|-----|------|------|
| **向量搜索** (Vector Search) | 余弦相似度 | 捕捉语义关联，擅长处理"概念匹配"，如将"登录流程"关联至"身份验证" |
| **BM25 搜索** (Lexical Matching) | 基于 FTS5 的词法匹配 | 处理"精确 Token"，如错误代码、函数名或特定 ID |

**检索触发方式**：通过 Prompt 触发，模型自动决策

**加权分数融合**：`Score = (0.7 * VectorScore) + (0.3 * BM25Score)`

#### 现有方案痛点

- **检索算法简陋**：召回不稳定、相关性弱，Agent 反复试错，Token 快速累积
- **上下文注入过量**：固定读取 today + yesterday + 长期记忆，无效上下文占比高
- **记忆缺少结构与去冗余**：工具调用长输出直接写入并反复重传，成本滚雪球

### OpenClaw + MemOS 的记忆方案

![MemOS-OpenClaw](https://cdn.memtensor.com.cn/img/1772627912577_gvwyaz_compressed.png)

#### 三大核心效果

**效果一：Token 成本可控 💰**
> 从"全量灌上下文"变成"按任务精确召回"

OpenClaw 不再每次固定塞入 today+yesterday+长期记忆，而是由 MemOS 按当前任务检索最相关的少量记忆（可设定召回预算/条数），显著降低无效上下文占比，避免 Token 滚雪球。

**效果二：检索更稳更准 🎯**
> 减少反复试错与重问，提升一次命中率

MemOS 提供更强的记忆组织与检索能力（结构化、分层/多粒度、语义检索 + 规则过滤等），让 OpenClaw 召回的内容相关性更强、稳定性更高，减少 Agent 因"召回不稳"导致的重复推理与反复确认。

**效果三：记忆更干净可用 ✨**
> 结构化 + 去冗余 + 高压缩，避免"长输出污染"

工具调用的长输出（如遍历结果、config/schema 等）不会直接原样反复写入上下文；MemOS 可以做摘要/压缩、去重与归档，长期运行越用越"清爽"，记忆质量随时间提升而不是劣化。

---

## 集成 MemOS OpenClaw 插件后的效果👇🏻

- ✅ 每次仅检索 3-5 条相关记忆
- ✅ 在 2,000-3,000 tokens 内保持上下文稳定性
- ✅ 无论对话多长，成本始终保持可控

### MemOS 插件能为 OpenClaw 带来的增强

| 功能 | 说明 |
|-----|------|
| **自动记忆所有对话** | 不依赖模型主动记录，确保关键信息不被遗漏 |
| **精准召回** | 基于当前任务意图检索相关记忆，避免无关历史数据 |
| **记住用户偏好** | 专门分类和存储偏好信息，跨会话保持有效 |

MemOS OpenClaw 重构了 Token 消耗模型，将成本从"历史长度函数"转变为"任务相关性函数"。你的本地 OpenClaw 成本变得可控，系统运行更加稳定。

---

## 快速开始

只需 3 步，即可让你的 Agent 具备基础记忆能力。

### 1. 安装 OpenClaw

确保你的系统中已安装 OpenClaw 环境：

```bash
# 安装最新版
npm install -g openclaw@latest

# 初始化并配置启动
openclaw onboard
```

### 2. 获取并配置 API Key

#### 2.1 获取 Key

登陆/注册 MemOS Cloud 获取你的 API Key 🔗 [MemOS Cloud](https://memos-dashboard.openmem.net/cn/apikeys/)

![image.png](https://cdn.memtensor.com.cn/img/1772443326905_kkxve6_compressed.webp)

#### 2.2 设置环境变量

插件会按顺序尝试读取 env 文件（**openclaw → moltbot → clawdbot**）。对于每个键，优先使用首个包含该值的文件。
如果这些文件都不存在（或缺少对应键），则会回退到进程环境变量。

**配置位置**
- 文件（优先级顺序）：
  - `~/.openclaw/.env`
  - `~/.moltbot/.env`
  - `~/.clawdbot/.env`
- 每行格式为 `KEY=value`

**快速配置（Shell）**
```bash
echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.zshrc
source ~/.zshrc

# or

echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.bashrc
source ~/.bashrc
```

**快速配置（Windows PowerShell）**
```powershell
[System.Environment]::SetEnvironmentVariable("MEMOS_API_KEY", "mpg-...", "User")
```

如果缺少 `MEMOS_API_KEY`，插件会提示配置说明和 API Key 获取链接。

**最小配置**
```env
MEMOS_API_KEY=YOUR_TOKEN
```

### 3. 安装插件

#### 方案 A — NPM（推荐）

```bash
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

> Windows 用户注意：如果遇到 `Error: spawn EINVAL`，这是 OpenClaw 插件安装器在 Windows 上的已知问题。请使用下面的方案 B（手动安装）。

请确认在 `~/.openclaw/openclaw.json` 中已启用：

```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    }
  }
}
```

#### 方案 B — 手动安装（Windows 兼容方案）

1. 从 [NPM](https://www.npmjs.com/package/@memtensor/memos-cloud-openclaw-plugin) 下载最新的 `.tgz` 包。
2. 解压到本地目录（例如：`C:\Users\YourName\.openclaw\extensions\memos-cloud-openclaw-plugin`）。
3. 配置 `~/.openclaw/openclaw.json`（或 `%USERPROFILE%\.openclaw\openclaw.json`）：

```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    },
    "load": {
      "paths": [
        "C:\\Users\\YourName\\.openclaw\\extensions\\memos-cloud-openclaw-plugin"
      ]
    }
  }
}
```

::info
注意：解压后的目录通常包含一个 `package` 子目录。请将路径指向包含 `package.json` 的文件夹。
::

配置修改后请重启 gateway。

### 4. 更新插件

你可以通过以下命令手动更新云服务插件到最新版本：

```bash
openclaw plugins update @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

## 开源项目进阶配置

如果希望进一步解锁更多可能性，还可以通过 MemOS Github 项目进行进一步探索和配置！

### 可视化配置界面 (Config UI)

自 `v0.1.12` 版本起，云插件内置了本地可视化配置服务，让您可以更直观地管理和修改插件配置。

**如何访问：**
1. 启动 OpenClaw 节点或宿主网关。
2. 插件成功加载并检测到网关就绪后，会自动在后台启动 Config UI 服务。
3. 在终端控制台日志中会打印访问链接（默认地址通常为 `http://127.0.0.1:38463`）。
4. 在浏览器中打开该链接，即可进入插件的可视化管理后台。

**功能特点：**
- **直观编辑**：支持以表单形式编辑所有核心配置（如知识库 ID、大模型检索参数、多 Agent 覆盖规则等）。
- **实时同步**：在界面上保存的配置变更会立即在插件运行时生效，无需重启服务。
- **状态监控**：界面提供与宿主网关的心跳检测，确保配置同步链路健康。

### 多Agent支持与隔离（Multi-Agent）

插件内置对多 Agent 模式的强大支持（通过 `agent_id` 参数实现），非常适合在复杂工作流或团队代理场景下使用。

**1. 开启与数据隔离**
- **开启方式**：在配置中设置 `"multiAgentMode": true` 或配置环境变量 `MEMOS_MULTI_AGENT_MODE=true`。
- **自动隔离**：开启后，插件会自动读取上下文中的 `ctx.agentId`。在进行记忆检索和写入时，会自动附带该 Agent 标识，从而保证同一用户下的不同 Agent 之间记忆数据完全隔离（注：默认的 `"main"` Agent 会被忽略以保证旧数据兼容性）。

**2. 按 Agent 开关记忆（白名单控制）**
在多 Agent 模式下，如果不想让所有 Agent 都产生记忆消耗，你可以使用 `allowedAgents` 精确控制白名单：
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": {
        "enabled": true,
        "config": {
          "multiAgentMode": true,
          "allowedAgents": ["research-agent", "coding-agent"]
        }
      }
    }
  }
}
```
*（提示：1. 如果 `allowedAgents` 未配置或为空数组 `[]`，则表示**所有 Agent** 都允许使用记忆检索和写入。2. 如果进行了配置，那么不在配置中的 Agent 将被完全跳过，只有配置中的 Agent 才会生效进行记忆检索和写入，从而避免 Token 浪费）。*

**3. 按 Agent 独立配置参数（agentOverrides）**
除了简单的开关，你还可以通过 `agentOverrides` 为**每个 Agent 单独覆写记忆参数**。例如，让研究助手拥有更宽松的检索阈值，而让代码助手只读取特定的代码库知识：

```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": {
        "enabled": true,
        "config": {
          "multiAgentMode": true,
          "allowedAgents": ["research-agent", "coding-agent"],
          "memoryLimitNumber": 6,
          "relativity": 0.45,

          "agentOverrides": {
            "research-agent": {
              "knowledgebaseIds": ["kb-research-papers"],
              "memoryLimitNumber": 12,
              "relativity": 0.3,
              "queryPrefix": "research context: "
            },
            "coding-agent": {
              "knowledgebaseIds": ["kb-codebase"],
              "memoryLimitNumber": 9,
              "addEnabled": false
            }
          }
        }
      }
    }
  }
}
```
*（在上面的例子中，`coding-agent` 被禁止了记忆写入，且只能检索 `kb-codebase` 知识库中的前 9 条高相关性记忆）。*

### 环境变量深度定制

除了必需的 API Key，你还可以通过环境变量调整插件行为。

更多细节配置项可以见 [MemTensor GitHub 官方插件仓库](https://github.com/MemTensor/MemOS/tree/main/apps/MemOS-Cloud-OpenClaw-Plugin)

## 测试记忆功能

现在，可以与你的 Agent 进行多轮对话，例如:

**第一次会话:**
- "我最喜欢的编程语言是 Python"
- "我正在开发一个电商项目"

**第二次会话(新启动):**
- "你还记得我喜欢用什么编程语言吗?"
- "我之前说的项目进展如何?"

现在，你的 OpenClaw 会从 MemOS Cloud 中检索记忆并给出准确回答啦～
