# Dream 插件

**MemOS Dream** 是一个由动机驱动的离线记忆重组系统——先形成内在动机，再围绕动机对异构记忆做定向召回与整合，最终以**梦境日记**（可解释的追溯）和**梦境记忆**（影响未来行为）两条线分别持久化。

> 没有"梦因"的 Dream 只是批处理总结，不是真正的梦。
> 真正的梦从"什么值得梦"出发，而不是从"有哪些记忆"出发。

## 设计理念

人脑的梦不是把白天的材料随机压缩一遍，而是围绕几类东西打转：

- **反复激活**过的东西
- **没解决完**的目标
- **情绪强烈**的事件
- **冲突很大**的信息
- **预期未来还会用到**的东西

Dream 模拟这一点：从*未完成的内在动机*出发，而不是从原始记忆列表出发。

## 叙事场景：把一天里分散的问题梦成一条主线

这个场景用于说明 Dream 为什么不是简单的夜间总结。白天的 AI 不一定是因为每个答案都错了才失败，它也可能是因为把用户连续的困扰拆成了几个互不相关的任务。

在这个例子里，用户先让 AI 帮忙准备下周周会，又讨论 AI 记忆系统的未来方向，最后讨论当前项目里的 filter 模块方案。AI 给出的每个回答单独看都有道理，但用户始终不满意，因为三个话题真正需要的是同一条战略主线。

```json
[
  {
    "role": "user",
    "content": "下周要开周会，帮我总结一下这周 Dream 和记忆系统相关的进展。"
  },
  {
    "role": "assistant",
    "content": "这周完成了检索实验、filter 接口调整、Dream pipeline 初版、用户访谈和一些评估准备。下周可以继续优化召回质量、完善指标，并推进产品化验证。"
  },
  {
    "role": "user",
    "content": "太像流水账了。我想讲得更有方向感，不只是列出做了什么。"
  },
  {
    "role": "assistant",
    "content": "可以改成 OKR：目标是提升长期记忆系统质量，关键结果包括召回效果提升、接口稳定、Dream 流程跑通、完成初步用户验证。"
  },
  {
    "role": "user",
    "content": "还是不对。下午我们换个问题：这个 AI 记忆系统未来到底应该往哪走？是做更强的搜索，还是做能主动理解人的智能体？"
  },
  {
    "role": "assistant",
    "content": "短期建议提升搜索和召回，中期增加个性化画像，长期发展为主动式智能助理。"
  },
  {
    "role": "user",
    "content": "这太泛了，谁都可以这么说。没有解释为什么非做这个不可。"
  },
  {
    "role": "assistant",
    "content": "可以表述为：我们要从被动检索走向主动记忆，让系统能在合适时间提醒用户重要信息。"
  },
  {
    "role": "user",
    "content": "晚上再讨论一个具体方案：现在项目里召回出来很多记忆，但真正有用的很少。我想做一个新的 filter 模块，你觉得怎么设计？"
  },
  {
    "role": "assistant",
    "content": "可以设计 relevance、importance、recency 三个分数，再接一个 reranker。接口上支持 metadata constraints，并加入用户反馈闭环。"
  },
  {
    "role": "user",
    "content": "这些都像零件。方案本身没有灵魂，我不知道怎么说服别人它重要。"
  }
]
```

白天失败的原因不是信息不足，而是问题边界被切得太碎。AI 把周报当成文案，把未来规划当成路线图，把 filter 当成工程模块，于是分别给出正确但空泛的局部建议。用户真正想解决的是另一个问题：如何把本周进展、长期方向和当前方案讲成同一个故事。

夜间 Dream 触发时，不需要复盘所有消息，而是聚焦白天反复出现的失败信号：用户多次反馈“太散”“太泛”“像零件”“没有方向感”。Dream 可以将这些信号和对应记忆聚成一个 motive：

```json
{
  "motive_id": "motive:dream_memory_strategy_alignment",
  "description": "Several conversations failed for the same hidden reason: weekly reporting, future planning, and filter design were treated as separate tasks, while the user needed a shared strategic narrative.",
  "memory_ids": ["weekly_report_thread", "future_planning_thread", "filter_design_thread"]
}
```

在梦里，AI 看到三张桌子。第一张桌子上是周报，写满完成事项，却没有标题；第二张桌子上是未来规划，路线很长，但起点是空的；第三张桌子上是 filter 架构图，阀门、分数、reranker 都在，却看不出这台机器要解决什么人的痛苦。

AI 一开始继续补局部答案：给周报加标题，给规划加愿景，给 filter 加评分公式。它们都很快塌掉，因为这些补丁仍然没有回答同一个核心问题。直到梦里出现一句话：

> 用户不是要一个更会搜索的 AI，而是要一个知道什么事情值得记住、什么时候该想起来、为什么此刻重要的 AI。

梦醒后的全局结论是：

> 这周所有工作都可以收束到“记忆选择层”。它短期是 filter，用来从大量候选记忆中选出当前真正有用的内容；中期是反思机制，用来把白天失败、冲突和碎片化记忆聚合成 insight；长期则是 AI 从被动搜索走向主动认知的起点。

因此，第二天 AI 可以同时改写三个答案。

周会汇报不再列流水账，而是说：

> 本周的核心发现是，长期记忆系统的瓶颈不只是能否召回更多内容，而是能否判断哪些记忆在当前语境下真正重要。围绕这个发现，我们做了检索实验、用户访谈、filter 接口调整和 Dream pipeline 初版验证。这些工作共同指向一个新的中间层：记忆选择层。

未来规划不再是泛泛地说“短期搜索、中期画像、长期智能体”，而是说：

> 未来的系统不应该只是 searchable memory，而应该成为 reflective memory。它不只是保存过去，还要持续判断哪些经历正在形成模式，哪些失败值得反思，哪些信息应该在未来某个时刻主动浮现。

filter 方案也不再只是零件列表，而是被重新定义为：

> filter 是记忆选择层的最小实现。第一版用 relevance、importance、recency 和当前目标做可解释筛选；第二版接入用户反馈，学习哪些记忆真的被采用；第三版接入 Dream，把白天没能解释清楚的分散记忆在夜间重新组织成新的 insight。

这个例子里的 Dream 不是神秘灵感，而是一次离线的问题重构。它把“白天三次不满意”视为同一个系统信号：用户不是缺少单点建议，而是缺少一条跨越周报、战略和工程方案的认知主线。

## Pipeline

```
 STEP 1             STEP 2              STEP 3               STEP 4
 形成梦因  ──────►  围绕动机召回  ──►  定向做梦  ──────────►  持久化
 (为什么值得梦)     (跨记忆类型)       (重组/整合)            (日记 + 记忆)
```

| 步骤 | 阶段类 | 做什么 |
|------|--------|--------|
| 1 | `MotiveFormation` | 由 LLM 分析待处理记忆，识别跨对话模式、未解决的张力和重复主题，分组为梦因簇。LLM 不可用时回退为单簇启发式策略。 |
| 2 | `DirectRecall` | 利用源记忆的 embedding 在 `UserMemory` 和 `LongTermMemory` 范围内做语义召回，结果去重并按相似度排序。 |
| 3 | `ConsolidationReasoning` | 由 LLM 驱动的深度做梦：组合源记忆与召回上下文，要求 LLM 重构问题并产出具体洞察。输出 `DreamAction`（CREATE → `InsightMemory`），附带假设演绎论证。LLM 不可用时回退为占位符。 |
| 4a | `StructuredDiarySummary` | 将推理输出包装为人类可读的日记条目（标题、摘要、梦境内容、动机上下文）。确定性逻辑，不额外调用 LLM。 |
| 4b | `DreamPersistence` | 对 `graph_db` 执行 DreamActions（create/update/merge/archive 跨记忆类型）+ 持久化日记。触发 `dream.before_persist` / `dream.after_persist` 钩子。 |

四个阶段均已完整实现。步骤 1 和 3 由 LLM 驱动（各有专属 prompt，位于 `prompts/`）；步骤 2 基于 embedding 语义召回；步骤 4a 和 4b 为确定性逻辑。当 LLM 不可用时，步骤 1 和 3 回退为简单启发式策略。每个阶段均可独立替换——见[参与贡献](#参与贡献)。

## 触发机制

```
add memory  ──►  on_add_signal  ──►  DreamSignalStore  ──►  达到阈值?
                                      (累积 memory ID)       ├─ 是 → 提交调度器任务 → pipeline
                                                             └─ 否 → 继续累积
```

也可通过 `POST /dream/trigger/cube` 手动触发。

## 目录结构

```
dream/
├── plugin.py          # 插件入口，组装与注册
├── hooks.py           # Hook 处理（信号捕获 + 执行编排）
├── hook_defs.py       # 插件级 hook（持久化前/后）
├── maintenance.py     # 生命周期维护（贡献入口）
├── signal_store.py    # 内存信号累积器
├── types.py           # 数据模型（DreamAction、DreamResult、DreamMemoryLifecycle 等）
├── pipeline/
│   ├── base.py        # Pipeline 编排器
│   ├── motive.py      # 阶段 1 — 动机形成
│   ├── recall.py      # 阶段 2 — 跨类型召回
│   ├── reasoning.py   # 阶段 3 — 整合推理（产出 DreamActions）
│   ├── diary.py       # 阶段 4a — 日记生成
│   └── persistence.py # 阶段 4b — 记忆回写 + 日记持久化
├── prompts/
│   ├── motive_prompt.py      # 动机形成 prompt
│   └── reasoning_prompt.py   # 整合推理 prompt
└── routers/
    ├── trigger_router.py  # POST /dream/trigger/cube
    └── diary_router.py    # POST /dream/diary
```

## API

### Dream 插件自身端点

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/dream/trigger/cube` | 手动触发指定 cube 的梦境任务 |
| POST | `/dream/diary` | 按条件查询梦境日记 |
| GET | `/dream/diary/health` | 插件状态与调度器连接情况 |

### 外部 API（通过 hook 向 Dream 输送信号）

| 方法 | 端点 | 关联方式 |
|------|------|---------|
| POST | `/add` | `@hookable("add")` → `add.after` hook → `on_add_signal` 累积 memory ID |
| POST | `/chat/complete`、`/chat/stream` | Chat 内部调用 `handle_add_memories` → 同样触发 `add.after` hook 链路 |

### 内部组件

| 组件 | 关联方式 |
|------|---------|
| `MemDreamMessageHandler`（调度器） | 消费 dream 任务 → `trigger_single_hook(H.DREAM_EXECUTE)` → pipeline |

### 查询示例

```json
POST /dream/diary
{
  "cube_id": "user_123",
  "filter": { "created_after": "2026-05-06", "limit": 5 }
}
```

## 持久化设计

### 双轨写入

Dream 持久化产出**两种结果**：

1. **记忆库记忆更新** — `DreamAction` 操作应用到异构记忆系统：
   - `LongTermMemory` / `UserMemory`
   - `SkillMemory`
   - `ProfileMemory`
   - `PreferenceMemory`
   - `InsightMemory`

2. **梦境日记更新** — 可解释的追溯记录，存入 `graph_db`，通过 diary API 查询。

### 持久化条件

一条 `DreamAction` 必须满足以下条件才会被持久化：

- **假设演绎通过**：`rationale` 字段必须论证"某个具体问题有了这条记忆可以回答得更好"。空 rationale → 跳过。
- **置信度 > 0**：推理阶段必须给出非零 confidence。

### 生命周期维护

每条 Dream 产出的记忆都附带 `DreamMemoryLifecycle` 元数据（定义在 `types.py`），设计用于定期维护清理。**数据模型已就位，但维护逻辑尚未实现**——见 `maintenance.py` 中的贡献指南。

| 条件 | 动作 |
|------|------|
| 长时间未被命中（`last_hit_at` 过期） | 衰减 / 归档 |
| 虽然被命中，但对 query 用处不大（`usefulness_score` 低于阈值） | 归档 |
| 被 feedback 等接口直接推翻（`invalidated_by_feedback = true`） | 立即归档 |

## 参与贡献

每个模块都可以独立替换：

| 想改进… | 起点文件 | 实现方法 |
|---------|---------|---------|
| 动机检测——增加 newness 之外的信号源（冲突、频率、反馈） | `motive.py`、`prompts/motive_prompt.py` | `form()` |
| 召回范围——扩展到 UserMemory / LongTermMemory 之外 | `recall.py` | `gather()` |
| 推理深度——多策略或多 action 输出 | `reasoning.py`、`prompts/reasoning_prompt.py` | `reason()` |
| 日记叙事——用 LLM 生成散文式叙事替代结构化包装 | `diary.py` | `generate()` |
| 持久化逻辑——写入前校验、冲突检测 | `persistence.py` | `persist()` |
| 定时维护清理（尚未实现） | `maintenance.py` | `run_maintenance()` |
| 信号策略（去重、衰减、冷却） | `signal_store.py` | `record_add()` / `should_trigger()` |
