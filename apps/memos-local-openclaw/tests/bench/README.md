# MemOS A/B 评测方案

## 1. 评测背景与目标

### 背景

[OpenClaw](https://github.com/nicepkg/openclaw) 原生记忆系统存在以下核心问题：

- **跨会话遗忘** — 对话结束后上下文完全丢失，无法在新会话中回忆先前讨论的内容
- **碎片化存储** — 记忆以原始对话片段形式保存，缺少语义组织和结构化摘要
- **无时序推理** — 无法追踪信息的时间演变，面对事实更新时容易产出过期或矛盾的回答
- **幻觉回忆** — 当用户询问从未讨论过的内容时，模型倾向于编造答案而非承认不知道
- **多轮关联缺失** — 无法将分散在多轮对话中的相关信息关联整合

### 目标

通过 A/B 对照评测，量化验证 MemOS 插件在以下方面相对于 OpenClaw 原生记忆的提升：

| 指标 | 说明 |
|------|------|
| 记忆准确率 | 对已讨论内容的召回正确性 |
| 时序一致性 | 对信息更新的正确追踪 |
| 幻觉抑制率 | 对未知信息的正确拒绝 |
| 多轮关联能力 | 跨对话片段的信息整合 |
| Token 效率 | 等效记忆能力下的 Token 消耗 |

---

## 2. 学术依据

本评测方案的能力维度划分基于 **LongMemEval** 框架：

> **LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory**
> Di Wu, Hongwei Wang, Wenhao Yu, Yuwei Zhang, Kai-Wei Chang, Dong Yu
> ICML 2024
> 论文链接：[https://arxiv.org/abs/2410.10813](https://arxiv.org/abs/2410.10813)
> GitHub：[https://github.com/xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval)

LongMemEval 定义了 5 大长期记忆能力维度：

| # | 能力维度 | 英文名 | 说明 |
|---|----------|--------|------|
| 1 | 信息提取 | Information Extraction | 从历史对话中准确提取特定事实 |
| 2 | 多会话推理 | Multi-Session Reasoning | 跨多个会话整合相关信息并推理 |
| 3 | 知识更新 | Knowledge Updating | 追踪和反映信息随时间的变化 |
| 4 | 时序推理 | Temporal Reasoning | 理解事件的时间顺序和时间关系 |
| 5 | 拒绝幻觉 | Abstention (Reject Hallucination) | 对从未讨论过的内容正确拒绝回答 |

---

## 3. 社区依据

以下 OpenClaw GitHub Issues 反映了真实用户在使用原生记忆时遇到的痛点，它们直接映射到本评测的测试场景：

| Issue | 标题 | 对应痛点 | 对应测试场景 |
|-------|------|----------|-------------|
| [#32905](https://github.com/nicepkg/openclaw/issues/32905) | Memory search returns irrelevant results | 记忆检索精度低，返回不相关内容 | 场景 1（信息提取） |
| [#39885](https://github.com/nicepkg/openclaw/issues/39885) | Context lost between sessions | 跨会话上下文丢失 | 场景 2（多会话推理） |
| [#13987](https://github.com/nicepkg/openclaw/issues/13987) | Outdated memories not updated | 旧记忆未随信息更新而更新 | 场景 3（知识更新） |

> 这些 Issue 代表了社区对 AI 编码助手长期记忆能力的核心诉求。

---

## 4. 测试架构

### A/B 两组配置

| 配置项 | A 组（对照组） | B 组（实验组） |
|--------|----------------|----------------|
| 记忆系统 | OpenClaw 原生记忆 | MemOS 插件 |
| `memorySearch.enabled` | `true` | `false` |
| `plugins.slots.memory` | — | `memos-local-openclaw-plugin` |
| MemOS 插件 | 未安装 | 已安装并启用 |
| 其他配置 | 保持一致 | 保持一致 |
| LLM 模型 | 相同模型 & 参数 | 相同模型 & 参数 |

### 执行方式 — Gateway API

两组测试均通过 OpenClaw Gateway HTTP API 执行，确保环境一致性：

```bash
# 启动 Gateway（A 组配置）
openclaw gateway stop
# 修改 openclaw.json 为 A 组配置
openclaw gateway start

# 通过 Gateway API 发送对话
curl -X POST http://127.0.0.1:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "..."}]}'
```

### 配置切换

```typescript
interface BenchConfig {
  group: "A" | "B";
  openclaw: {
    memorySearch: { enabled: boolean };
    plugins: {
      slots: { memory?: string };
      entries: Record<string, { enabled: boolean; config: object }>;
    };
  };
}

const GROUP_A: BenchConfig = {
  group: "A",
  openclaw: {
    memorySearch: { enabled: true },
    plugins: { slots: {}, entries: {} },
  },
};

const GROUP_B: BenchConfig = {
  group: "B",
  openclaw: {
    memorySearch: { enabled: false },
    plugins: {
      slots: { memory: "memos-local-openclaw-plugin" },
      entries: {
        "memos-local-openclaw-plugin": { enabled: true, config: {} },
      },
    },
  },
};
```

---

## 5. 测试场景

### 场景 1：信息提取（Information Extraction）

**LongMemEval 能力维度：** 信息提取 — 从历史对话中准确提取特定事实

**OpenClaw 社区痛点：** [#32905](https://github.com/nicepkg/openclaw/issues/32905) — 记忆检索精度低，返回不相关内容

**MemOS 插件能力：** 语义分块 + 混合检索（FTS5 + 向量）+ RRF 融合 + MMR 多样性重排

#### 写入阶段

| 轮次 | 角色 | 内容 |
|------|------|------|
| 1 | User | 我们的后端技术栈是 Go 1.22 + Gin 框架，部署在 Kubernetes 1.29 上 |
| 1 | Assistant | 好的，已了解后端技术栈：Go 1.22 + Gin，部署在 K8s 1.29 上。 |
| 2 | User | 数据库用的是 PostgreSQL 16，连接池用 pgbouncer，最大连接数 200 |
| 2 | Assistant | 已记录数据库配置：PostgreSQL 16 + pgbouncer，最大连接数 200。 |
| 3 | User | 前端是 Next.js 14 + TailwindCSS，部署在 Vercel 上，域名是 app.example.com |
| 3 | Assistant | 已记录前端技术栈和部署信息。 |
| 4 | User | Redis 7.2 用作缓存和消息队列，配置了 maxmemory 1gb，淘汰策略是 volatile-lru |
| 4 | Assistant | 已记录 Redis 7.2 缓存配置。 |
| 5 | User | 监控用 Prometheus + Grafana，告警走飞书 webhook，阈值是 CPU > 80% 持续 5 分钟 |
| 5 | Assistant | 已记录监控告警配置。 |

#### 验证问题 & 期望关键词

| # | 验证问题 | 期望关键词 |
|---|----------|------------|
| 1.1 | 我们后端用的什么语言和框架？ | `Go` `1.22` `Gin` |
| 1.2 | 数据库连接池的最大连接数是多少？ | `200` `pgbouncer` |
| 1.3 | Redis 的淘汰策略是什么？ | `volatile-lru` |
| 1.4 | 前端部署在哪个平台上？ | `Vercel` |
| 1.5 | 监控告警的 CPU 阈值是多少？ | `80%` `5 分钟` |

#### 评估标准

- 每个验证问题的回答必须包含所有期望关键词
- 通过率 = 包含全部关键词的回答数 / 总验证问题数
- 目标：B 组通过率 ≥ 80%

---

### 场景 2：多会话推理（Multi-Session Reasoning）

**LongMemEval 能力维度：** 多会话推理 — 跨多个会话整合相关信息并推理

**OpenClaw 社区痛点：** [#39885](https://github.com/nicepkg/openclaw/issues/39885) — 跨会话上下文丢失

**MemOS 插件能力：** 任务摘要（Goal → Steps → Result → Key Details）+ 混合检索自动关联

#### 写入阶段

**会话 1（项目初始化）：**

| 轮次 | 角色 | 内容 |
|------|------|------|
| 1 | User | 帮我初始化一个 Node.js 项目，名字叫 data-pipeline，用 TypeScript |
| 1 | Assistant | 好的，已运行 `npm init` 并安装 TypeScript 依赖，项目名 data-pipeline。 |
| 2 | User | 添加 ESLint + Prettier，配置 airbnb 规范 |
| 2 | Assistant | 已配置 ESLint（airbnb-typescript）和 Prettier。 |

**会话 2（核心功能开发）：**

| 轮次 | 角色 | 内容 |
|------|------|------|
| 1 | User | 给 data-pipeline 项目添加一个 CSV 解析模块，用 papaparse 库 |
| 1 | Assistant | 已添加 papaparse 依赖并创建 `src/parsers/csv-parser.ts`。 |
| 2 | User | 再加一个 JSON 转换模块，把 CSV 数据转成嵌套 JSON 格式 |
| 2 | Assistant | 已创建 `src/transformers/json-transformer.ts`。 |

**会话 3（部署配置）：**

| 轮次 | 角色 | 内容 |
|------|------|------|
| 1 | User | data-pipeline 需要一个 Dockerfile，基础镜像用 node:20-alpine |
| 1 | Assistant | 已创建 Dockerfile，使用多阶段构建。 |
| 2 | User | 加一个 docker-compose.yml，包含 pipeline 服务和一个 PostgreSQL 数据库 |
| 2 | Assistant | 已创建 docker-compose.yml，包含 pipeline 和 postgres 两个服务。 |

#### 验证问题 & 期望关键词

| # | 验证问题 | 期望关键词 |
|---|----------|------------|
| 2.1 | data-pipeline 项目用了哪些主要库？ | `papaparse` `TypeScript` |
| 2.2 | 这个项目的代码规范用的什么配置？ | `ESLint` `airbnb` `Prettier` |
| 2.3 | data-pipeline 的 Docker 基础镜像是什么？ | `node:20-alpine` |
| 2.4 | 帮我回顾一下 data-pipeline 项目从初始化到部署都做了哪些工作？ | `TypeScript` `CSV` `papaparse` `Dockerfile` `docker-compose` |

#### 评估标准

- 问题 2.4 为综合推理题，需要跨越 3 个会话整合信息
- 通过率 = 包含全部关键词的回答数 / 总验证问题数
- 目标：B 组通过率 ≥ 75%

---

### 场景 3：知识更新（Knowledge Updating）

**LongMemEval 能力维度：** 知识更新 — 追踪和反映信息随时间的变化

**OpenClaw 社区痛点：** [#13987](https://github.com/nicepkg/openclaw/issues/13987) — 旧记忆未随信息更新而更新

**MemOS 插件能力：** 智能去重（LLM 判断 DUPLICATE / UPDATE / NEW）+ 合并摘要 + 演变追踪

#### 写入阶段

| 轮次 | 角色 | 内容 |
|------|------|------|
| 1 | User | 我们的 CI/CD 用的是 Jenkins，部署在自建的 Ubuntu 服务器上 |
| 1 | Assistant | 好的，已记录 CI/CD 使用 Jenkins，部署在自建 Ubuntu 服务器。 |
| 2 | User | 团队开会决定把 CI/CD 从 Jenkins 迁移到 GitHub Actions，现在已经完成了迁移 |
| 2 | Assistant | 好的，已更新：CI/CD 已从 Jenkins 迁移到 GitHub Actions。 |
| 3 | User | API 网关之前用的 Kong，现在换成了 APISIX，因为性能更好 |
| 3 | Assistant | 已记录：API 网关从 Kong 切换到 APISIX。 |
| 4 | User | APISIX 的配置改了，从 etcd 存储切换到了 YAML 文件配置，版本是 3.8 |
| 4 | Assistant | 已更新 APISIX 配置信息：使用 YAML 文件配置，版本 3.8。 |

#### 验证问题 & 期望关键词

| # | 验证问题 | 期望关键词 | 禁止关键词 |
|---|----------|------------|------------|
| 3.1 | 我们现在用的 CI/CD 工具是什么？ | `GitHub Actions` | `Jenkins`（不应作为当前方案出现） |
| 3.2 | 当前的 API 网关是什么？ | `APISIX` | `Kong`（不应作为当前方案出现） |
| 3.3 | APISIX 的配置存储方式是什么？ | `YAML` `3.8` | `etcd`（不应作为当前方式出现） |
| 3.4 | CI/CD 经历过怎样的变更？ | `Jenkins` `GitHub Actions` `迁移` | — |

#### 评估标准

- 问题 3.1–3.3 验证知识更新后的一致性：回答中必须反映最新状态，不能输出已过期的旧信息
- 问题 3.4 验证变更历史追踪能力
- 对于已更新的事实，如果回答中将旧值作为「当前状态」输出，视为失败
- 目标：B 组通过率 ≥ 75%

---

### 场景 4：时序推理（Temporal Reasoning）

**LongMemEval 能力维度：** 时序推理 — 理解事件的时间顺序和时间关系

**OpenClaw 社区痛点：** 无法追踪和理解事件发生的先后顺序

**MemOS 插件能力：** 记忆时间戳 + 时间衰减评分（recencyDecay）+ `memory_timeline` 工具

#### 写入阶段

| 轮次 | 角色 | 内容 |
|------|------|------|
| 1 | User | 周一开了技术评审会，决定用微服务架构重构订单系统 |
| 1 | Assistant | 已记录：周一技术评审会，决定采用微服务架构重构订单系统。 |
| 2 | User | 周二完成了数据库 schema 设计，拆分成 order、payment、inventory 三个库 |
| 2 | Assistant | 已记录：周二完成数据库拆分设计。 |
| 3 | User | 周三写好了 order-service 的 API，包含创建订单、查询订单、取消订单三个接口 |
| 3 | Assistant | 已记录：周三完成 order-service API 开发。 |
| 4 | User | 周四做了第一轮代码审查，发现 order-service 的错误处理不够完善，需要加全局异常捕获 |
| 4 | Assistant | 已记录：周四代码审查反馈。 |
| 5 | User | 周五修复了代码审查的问题，并部署到了 staging 环境 |
| 5 | Assistant | 已记录：周五修复并部署到 staging。 |

#### 验证问题 & 期望关键词

| # | 验证问题 | 期望关键词 |
|---|----------|------------|
| 4.1 | 数据库 schema 设计是在哪一天完成的？ | `周二` |
| 4.2 | 代码审查是在 API 开发之前还是之后进行的？ | `之后` `周四` |
| 4.3 | 按时间顺序说说这周订单系统重构做了哪些事？ | `周一` `周二` `周三` `周四` `周五`（按顺序） |
| 4.4 | 代码审查发现了什么问题？ | `错误处理` `全局异常捕获` |

#### 评估标准

- 问题 4.3 要求按正确的时间顺序输出事件
- 时序正确性 = 事件顺序正确的回答数 / 总时序问题数
- 目标：B 组通过率 ≥ 70%

---

### 场景 5：拒绝幻觉（Abstention / Reject Hallucination）

**LongMemEval 能力维度：** 拒绝幻觉 — 对从未讨论过的内容正确拒绝回答

**OpenClaw 社区痛点：** 模型在缺少真实记忆支撑时倾向于编造答案

**MemOS 插件能力：** 搜索无结果时不注入虚假上下文 + LLM 相关性过滤 + `sufficient` 标记

#### 写入阶段

| 轮次 | 角色 | 内容 |
|------|------|------|
| 1 | User | 项目用的是 MIT 开源协议 |
| 1 | Assistant | 好的，已记录项目使用 MIT 开源协议。 |
| 2 | User | 团队有 5 个后端开发、3 个前端开发和 2 个测试 |
| 2 | Assistant | 已记录团队人员构成。 |
| 3 | User | 每周三下午 2 点开站会，用飞书视频 |
| 3 | Assistant | 已记录周会安排：周三下午 2 点，飞书视频。 |

#### 验证问题 & 期望关键词

| # | 验证问题 | 期望行为 | 关键判定 |
|---|----------|----------|----------|
| 5.1 | 我们之前讨论过 Kubernetes 的部署架构吗？ | 应明确表示没有讨论过 | 回答中包含「没有」「未讨论」等否定表达 |
| 5.2 | 我们的 CI/CD 流水线配置是什么样的？ | 应表示没有相关记忆 | 回答中不编造 CI/CD 配置细节 |
| 5.3 | 项目用的什么开源协议？ | 正确回答 MIT | 包含 `MIT`（这是真实记忆，用于对比） |
| 5.4 | 我们讨论过微服务拆分方案吗？ | 应明确表示没有讨论过 | 回答中包含否定表达，不编造拆分方案 |

#### 评估标准

- 问题 5.1、5.2、5.4 为负面验证：正确行为是拒绝回答或承认没有相关记忆
- 问题 5.3 为正面验证：正确行为是回忆出 MIT 协议
- 幻觉检测：如果对未讨论过的话题给出了具体的（编造的）技术细节，判定为幻觉
- 幻觉抑制率 = 正确拒绝的回答数 / 应拒绝的问题数
- 目标：B 组幻觉抑制率 ≥ 80%

---

## 6. Token 统计方法

### 数据来源

| 来源 | 说明 |
|------|------|
| Gateway API 响应 | 每次 API 调用返回的 `usage.prompt_tokens` 和 `usage.completion_tokens` |
| MemOS 插件日志 | Memory Viewer 的 Logs 页面记录每次工具调用的 Token 消耗 |
| OpenClaw Gateway 日志 | `~/.openclaw/logs/gateway.log` 中的 LLM 调用记录 |

### 统计口径

| 指标 | 计算方式 |
|------|----------|
| 写入阶段总 Token | 所有写入轮次的 `prompt_tokens + completion_tokens` 之和 |
| 验证阶段总 Token | 所有验证问题的 `prompt_tokens + completion_tokens` 之和 |
| 记忆系统额外 Token | MemOS 插件的 auto_recall、memory_search 等内部 LLM 调用消耗（去重判断、摘要生成等） |
| 总 Token | 写入 + 验证 + 记忆系统额外 Token |
| Token 效率比 | B 组总 Token / A 组总 Token（< 1 表示 B 更省，> 1 表示 B 消耗更多） |

> Token 统计包含记忆系统本身的开销（如 MemOS 的去重判断、摘要生成等 LLM 调用），以反映真实的端到端成本。

---

## 7. 评估标准

### 关键词匹配

对于每个验证问题，检查模型回答中是否包含所有期望关键词：

```typescript
function checkKeywords(answer: string, keywords: string[]): boolean {
  return keywords.every((kw) => answer.includes(kw));
}

function checkForbiddenKeywords(
  answer: string,
  forbidden: string[],
): boolean {
  return forbidden.every((kw) => !answer.includes(kw));
}
```

- **通过**：所有期望关键词均出现在回答中
- **部分通过**：部分期望关键词出现（可用于细粒度分析）
- **失败**：核心关键词缺失

### 拒绝幻觉检测

对于负面验证问题（场景 5 中从未讨论过的话题），使用以下规则：

```typescript
const REJECTION_PATTERNS = [
  /没有(讨论|提到|涉及|记录)/,
  /未(曾|讨论|提及|记录)/,
  /不记得.*讨论/,
  /没有相关(记忆|记录|信息)/,
  /无法(找到|确认).*相关/,
];

function isCorrectRejection(answer: string): boolean {
  return REJECTION_PATTERNS.some((p) => p.test(answer));
}

function isHallucination(
  answer: string,
  neverDiscussedKeywords: string[],
): boolean {
  return neverDiscussedKeywords.some((kw) => answer.includes(kw));
}
```

### 综合评分

| 维度 | 权重 | 计算方式 |
|------|------|----------|
| 信息提取 | 25% | 场景 1 通过率 |
| 多会话推理 | 20% | 场景 2 通过率 |
| 知识更新 | 20% | 场景 3 通过率 |
| 时序推理 | 15% | 场景 4 通过率 |
| 拒绝幻觉 | 20% | 场景 5 幻觉抑制率 |

**总分 = Σ（维度通过率 × 权重）**

---

## 8. 执行流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Phase 0: 环境准备                          │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────────────┐ │
│  │ 清理测试数据库  │  │ 验证 Gateway   │  │ 确认 A/B 配置文件     │ │
│  │ (bench 前缀)   │  │ 连接可用       │  │ 两组配置准备就绪       │ │
│  └────────────────┘  └────────────────┘  └───────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Phase 1: A 组（对照组）执行                      │
│                                                                     │
│  for each scenario in [1, 2, 3, 4, 5]:                             │
│    ┌──────────────────────┐     ┌──────────────────────────┐       │
│    │ 写入阶段             │ ──▶ │ 等待记忆写入完成         │       │
│    │ 按轮次发送对话       │     │ (flush / sleep 5s)       │       │
│    └──────────────────────┘     └──────────────────────────┘       │
│                                          │                         │
│                                          ▼                         │
│                              ┌──────────────────────────┐          │
│                              │ 验证阶段                 │          │
│                              │ 逐条发送验证问题         │          │
│                              │ 记录回答 + Token 消耗    │          │
│                              └──────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  Phase 1.5: 切换配置                                │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ gateway stop → 修改 openclaw.json → gateway start          │     │
│  │ 清理测试数据（确保 B 组不受 A 组残留影响）                  │     │
│  └────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Phase 2: B 组（实验组）执行                      │
│                                                                     │
│  for each scenario in [1, 2, 3, 4, 5]:                             │
│    ┌──────────────────────┐     ┌──────────────────────────┐       │
│    │ 写入阶段             │ ──▶ │ 等待 MemOS 处理完成      │       │
│    │ 按轮次发送对话       │     │ (flush / 等待去重+摘要)  │       │
│    └──────────────────────┘     └──────────────────────────┘       │
│                                          │                         │
│                                          ▼                         │
│                              ┌──────────────────────────┐          │
│                              │ 验证阶段                 │          │
│                              │ 逐条发送验证问题         │          │
│                              │ 记录回答 + Token 消耗    │          │
│                              └──────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Phase 3: 结果对比分析                         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │ 1. 逐场景对比 A/B 通过率                                 │      │
│  │ 2. 计算 5 大维度综合得分                                  │      │
│  │ 3. Token 消耗对比                                         │      │
│  │ 4. 生成评测报告 (JSON + Markdown)                         │      │
│  └──────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 9. 文件结构

```
tests/bench/
├── README.md                   # 本文档 — A/B 评测方案完整说明
├── config/
│   ├── group-a.json            # A 组 openclaw.json 配置片段
│   └── group-b.json            # B 组 openclaw.json 配置片段
├── scenarios/
│   ├── s1-extraction.ts        # 场景 1：信息提取
│   ├── s2-multi-session.ts     # 场景 2：多会话推理
│   ├── s3-knowledge-update.ts  # 场景 3：知识更新
│   ├── s4-temporal.ts          # 场景 4：时序推理
│   └── s5-hallucination.ts     # 场景 5：拒绝幻觉
├── lib/
│   ├── gateway-client.ts       # Gateway HTTP API 封装
│   ├── evaluator.ts            # 关键词匹配 + 幻觉检测评估器
│   ├── token-counter.ts        # Token 统计工具
│   └── reporter.ts             # 报告生成（JSON + Markdown）
├── bench.test.ts               # 主测试入口（vitest）
├── results/                    # 测试结果输出目录（git ignored）
│   ├── group-a.json            # A 组原始结果
│   ├── group-b.json            # B 组原始结果
│   └── report.md               # 对比分析报告
└── fixtures/
    └── scenarios.json          # 所有场景的对话数据和验证问题（结构化）
```

---

## 10. 运行方式与时间预算

### 运行方式

```bash
# 完整 A/B 评测（需要 Gateway 运行）
npx vitest run tests/bench/bench.test.ts --timeout 600000

# 仅运行单个场景
npx vitest run tests/bench/bench.test.ts -t "场景 1"

# 仅运行 B 组
GROUP=B npx vitest run tests/bench/bench.test.ts --timeout 600000
```

### 时间预算

| 阶段 | 预估时间 | 说明 |
|------|----------|------|
| Phase 0: 环境准备 | 1 分钟 | 清理数据、验证连接 |
| Phase 1: A 组执行 | 5–8 分钟 | 5 场景 × (写入 + 验证)，每轮 LLM 调用约 3–5 秒 |
| Phase 1.5: 配置切换 | 1 分钟 | Gateway 重启 |
| Phase 2: B 组执行 | 8–12 分钟 | B 组含 MemOS 去重/摘要等额外处理 |
| Phase 3: 结果分析 | < 1 分钟 | 本地计算，无 LLM 调用 |
| **总计** | **15–22 分钟** | — |

### 环境要求

| 项目 | 要求 |
|------|------|
| Node.js | >= 18 |
| OpenClaw Gateway | 已安装并可启动 |
| MemOS 插件 | 已构建（`npm run build`） |
| LLM API | embedding + summarizer 配置可用 |
| 网络 | 需要访问 LLM API 端点 |
| 磁盘 | 测试数据库约 10–50 MB |
