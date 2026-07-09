# SkillFlow Feedback Experience Optimization Plan

本文档整理 SkillFlow 测评场景下的记忆算法优化方案。目标是让 verifier feedback 和用户显著反馈真正进入“经验 -> 技能 -> 环境认知”的沉淀链路，同时避免把失败噪音错误包装成可执行 skill。

## 背景

SkillFlow 的测评流程不是把同一道题反复重跑到成功，而是：

1. 每个任务作为一次独立 trial 跑一遍。
2. 运行 verifier，得到通过/失败和具体反馈。
3. 把 verifier feedback 交给 agent，作为下一轮同族任务的学习信号。
4. 下一道同族任务检查前一轮沉淀出的经验、技能、环境认知是否能提升表现。

因此，失败任务不能只作为“反例”沉底。只要 verifier 或用户给出了明确、可行动的反馈，就应该沉淀为经验，供下一题召回。

但同时需要防止另一个错误：只知道“不要怎么做”的失败经验，不能单独结晶成 skill。skill 是可执行能力，必须至少有一条成功锚点。

## 当前问题

当前项目里，记忆面板中的概念和后端对象大致对应如下：

| 面板术语 | 后端主要对象 | 说明 |
| --- | --- | --- |
| 记忆 | `traces` | 单轮任务或步骤的原始过程记录 |
| 经验 | `policies` | 从任务中总结出的可复用做法 |
| 技能 | `skills` | 从经验包装出的可调用能力 |
| 环境认知 | `world_model` | 多条经验共同指向的环境规律 |

现有链路的主要断点：

1. 经验生成主要依赖正价值记录。
   `core/memory/l2/l2.ts` 里筛选条件是 `t.value >= minTraceValue`，失败任务的负分记录一般不会进入经验生成池。

2. 失败记录优先级被压到 0。
   `core/reward/backprop.ts` 使用 `priority = max(V, 0) * decay`。这对普通记忆排序合理，但会导致失败避坑经验在普通召回里缺席。

3. 显式 feedback 没有完整闭环。
   `core/pipeline/memory-core.ts::submitFeedback` 当前主要是写入 `feedback` 表，没有保证触发 reward 重算、经验生成、决策修复和 skill 更新。

4. Hermes verifier feedback 常被当成普通对话。
   如果 feedback 只是通过普通 prompt 发送，系统可能只记录为一条聊天记忆，而不是结构化反馈事件。

5. skill 结晶没有明确区分“成功经验”和“失败避坑经验”。
   如果后续把失败经验纳入正式召回和经验表，必须增加 skill eligibility 约束，避免只由失败避坑经验生成 skill。

## 设计原则

1. **显著反馈一定要进入经验链路**

   无论任务成功还是失败，只要用户或 verifier 给出了明确、可行动的评价反馈，就应该生成或更新经验。

2. **绝对值表示重要性，正负号决定类型**

   不能简单把 `l2Induction.minTraceValue` 调成负数，也不能把所有 `abs(V)` 大的失败 trace 都拿来生成经验。

   正确做法是：

   - `abs(R)`、feedback magnitude、classifier confidence 用来判断这条反馈是否重要。
   - feedback polarity、verifier result、文本分类结果用来决定经验类型。
   - 只有通过“显著反馈 + 可行动性”门槛的失败，才生成避坑型经验。

3. **避坑型经验可召回，但不能单独生成 skill**

   失败避坑经验应该参与后续 prompt 注入，提醒 agent 避免重复错误。但它只能作为 skill 的 `Avoid / Check / Repair` 补充材料，不能作为 skill 主证据。

4. **skill 必须有成功锚点**

   skill 生成必须至少包含一条成功型经验，例如：

   - `success_pattern`
   - `repair_validated`

   只有 `failure_avoidance`、`repair_instruction` 或 `preference` 的经验集合不能生成 skill。

5. **召回要做来源去重**

   如果某条经验已经被某个召回的 skill 吸收，并且 skill 比经验更新，则 prompt 里不重复注入该经验。否则会造成内容重复和指令冲突。

## 经验类型

建议给经验增加明确类型。

| 类型 | 含义 | 可召回 | 可作为 skill 主证据 |
| --- | --- | --- | --- |
| `success_pattern` | 成功任务中沉淀出的做法 | 是 | 是 |
| `repair_validated` | 之前失败，按反馈修复后验证成功 | 是 | 是 |
| `failure_avoidance` | 失败后的避坑经验 | 是 | 否 |
| `repair_instruction` | 失败后的修复建议，但尚未验证成功 | 是 | 否 |
| `preference` | 用户偏好或格式偏好 | 是 | 否 |
| `verifier_feedback` | verifier 反馈提炼出的测评经验，可再细分 polarity | 是 | 取决于是否有成功锚点 |

说明：

- `verifier_feedback` 更适合作为来源标签，而不是唯一类型。实际可落到 `failure_avoidance`、`repair_instruction`、`success_pattern` 等类型上。
- `repair_instruction` 只有在后续任务成功命中同一修复思路后，才升级或派生为 `repair_validated`。

## 显著反馈判定

新增 feedback experience builder，触发条件建议如下：

```text
is_significant =
  explicit_feedback
  AND actionable
  AND (
    feedback.magnitude >= 0.5
    OR classifier.confidence >= 0.6
    OR abs(episode.r_task) >= 0.5
    OR verifier_severity >= 0.5
  )
```

其中：

- `explicit_feedback`：来自 `feedback.submit`、verifier feedback、用户明确评价、用户明确纠正。
- `actionable`：文本中能提取出下次怎么做、不要怎么做、哪里错了、应该改成什么。
- `verifier_severity`：由 verifier 的失败程度计算，例如字段缺失、schema 错误、数值偏差、expected/actual mismatch。

不应该生成经验的例子：

- “wrong”
- “不对”
- “再试试”
- 普通负分 trace，但没有用户/ verifier 的明确可行动反馈

应该生成经验的例子：

- “Do not reuse the previous task's answers.json schema.”
- “Expected top_class_labels/top_class_counts, but the answer used the previous task's stock_holding schema.”
- “Next time, parse every infoTable record before aggregating stock holdings.”
- “This is correct; the 13F parser handled all holdings and matched verifier output.”

## Salience 计算

新增 `salience` 表示反馈重要性：

```text
salience = clamp01(max(
  abs(episode.r_task),
  feedback.magnitude,
  classifier.confidence,
  verifier_severity
))
```

注意：

- `salience` 不等于成功分。
- `salience` 高的负反馈生成高重要性的避坑经验。
- `salience` 高的正反馈生成高重要性的成功经验。
- 经验类型必须保留 polarity，不能把负反馈伪装成正向 skill 证据。

## 数据模型建议

当前 `policies` 表已经是面板里的“经验”。建议扩展字段，而不是新增一个完全平行的经验表。

建议新增：

```text
experience_type TEXT
evidence_polarity TEXT
salience REAL
confidence REAL
source_feedback_ids_json TEXT
source_trace_ids_json TEXT
verifier_meta_json TEXT
skill_eligible INTEGER
```

字段含义：

- `experience_type`：经验类型。
- `evidence_polarity`：`positive` / `negative` / `mixed`。
- `salience`：反馈重要性。
- `confidence`：这条经验本身可信度。
- `source_feedback_ids_json`：来源 feedback。
- `source_trace_ids_json`：来源 trace，解决当前只追到 episode、不追到具体证据的问题。
- `verifier_meta_json`：任务名、expected/actual 摘要、schema mismatch、失败字段等。
- `skill_eligible`：是否可作为 skill 主证据。失败避坑类默认为 false。

也可以先不加 `skill_eligible` 字段，在 skill eligibility 里由 `experience_type` 动态判断。但显式字段更方便 viewer 和日志解释。

## 反馈提交流水线

`feedback.submit` 应改成完整闭环：

1. 写入 `feedback` 表。
2. 通知 reward subscriber 对对应 episode 重新评分或补评分。
3. 通知 feedback subscriber 做决策修复。
4. 触发 feedback experience builder。
5. flush reward、经验、skill、环境认知队列，保证下一题开始前可召回。

伪流程：

```text
submitFeedback(feedback):
  row = feedbackRepo.insert(feedback)

  reward.submitFeedback(row)
  repair.submitUserFeedback(row.rawText, row.sessionId, row.episodeId)
  feedbackExperience.run(row)

  await reward.drain()
  await feedbackExperience.drain()
  await skill.flush()
  await worldModel.flush()

  return row
```

Hermes verifier feedback 不应只走普通对话。优先方案：

1. SkillFlow runner 在 verifier 后调用结构化 `feedback.submit`。
2. `raw` 中包含 verifier result、task name、expected/actual 摘要。
3. `polarity` 根据 verifier pass/fail 填 positive/negative。
4. `magnitude` 根据 verifier 严重程度计算。

兼容方案：

- 如果仍通过普通 prompt 给 Hermes，则 adapter 或 core 识别 `Verifier feedback for completed task ...` 这类模式，自动转成结构化 feedback，并绑定到刚完成的 episode。

## 经验生成流程

新增 feedback-derived experience path，和现有正向 trace 聚类 path 并行。

### 现有路径保留

保留当前：

```text
正价值 trace
  -> candidate pool
  -> 相似任务达到阈值
  -> 生成普通经验
```

不要把 `minTraceValue` 全局改成负数。

### 新增路径

```text
显著反馈
  -> 分类 polarity / type / actionable lesson
  -> 匹配已有经验
  -> 更新已有经验，或创建新经验
  -> 按类型决定是否 active、是否 skill-eligible
```

创建/更新规则：

- 如果相似经验已存在，合并来源 feedback、trace、episode，并更新 decision guidance。
- 如果没有相似经验，创建新经验。
- 显著 verifier 失败可以在单个 episode 后生成经验，不必等两个相似任务。
- 失败避坑经验可以直接 recallable，但 `skill_eligible=false`。

经验状态建议：

| 情况 | 初始状态 |
| --- | --- |
| 高置信用户正反馈成功经验 | `active` |
| verifier pass 生成成功经验 | `active` |
| 高置信 verifier fail 避坑经验 | `active`，但 `skill_eligible=false` |
| 低置信但可行动反馈 | `candidate` |
| 纯偏好 | `active` 或 `candidate`，取决于置信度 |

这里的 `active` 表示“可以被召回”，不等于“可以生成 skill”。skill 生成由 `skill_eligible` 和成功锚点单独控制。

## Skill 生成规则

修改 `core/skill/eligibility.ts` 的判断逻辑。

现有核心条件：

```text
experience.status == active
experience.gain >= skill.minGain
experience.support >= skill.minSupport
```

新增条件：

```text
has_success_anchor(experience) == true
```

`has_success_anchor` 为 true 的情况：

1. `experience_type == success_pattern`
2. `experience_type == repair_validated`
3. 来源 episode 有明确成功反馈，且 verifier pass
4. 来源 feedback polarity 为 positive，且 actionable 内容描述的是已成功做法

`has_success_anchor` 为 false 的情况：

1. 只有 `failure_avoidance`
2. 只有 `repair_instruction`
3. 只有 `preference`
4. 只有 verifier fail，没有后续成功验证

失败避坑经验在 skill 结晶中仍然有价值，但只能作为补充：

- 写入 skill 的 `Avoid` 段。
- 写入 skill 的 `Check` 段。
- 写入 skill 的 decision guidance。
- 作为 counter example 传给 skill crystallizer。

示例：

```text
成功经验：
  SEC 13F task should first confirm target answers.json schema, then parse all infoTable rows.

避坑经验：
  Do not reuse the previous task's answers.json schema.

生成 skill：
  Procedure:
  - Confirm current task schema.
  - Parse all infoTable rows.
  - Aggregate according to the requested fields.

  Avoid:
  - Do not reuse the previous task's answers.json fields.
```

不允许：

```text
只有避坑经验：
  Do not reuse previous schema.

直接生成 skill：
  SEC 13F solver
```

原因：它只说明了不要做什么，没有证明应该怎么做能成功。

## 召回优化

新增“经验召回”作为正式召回通道。

当前普通召回主要包括：

- skill
- 记忆 trace / episode
- 环境认知 world model

建议加入：

- active 经验
- 高置信 candidate 经验，可选
- failure avoidance / repair instruction / preference 等 typed experience

召回排序建议：

```text
score =
  0.45 * query_similarity
  + 0.25 * salience_or_gain
  + 0.15 * confidence
  + 0.10 * recency
  + 0.05 * support
```

注入格式按类型区分：

```text
## Relevant Experiences

Do:
- ...

Avoid:
- ...

Check:
- ...
```

失败避坑经验不要混进普通 “here is what worked” 文案里，必须明确为 Avoid/Check。

## Skill 和经验去重

召回后做 provenance 去重。

需要让 skill candidate 带上：

```text
sourcePolicyIds
updatedAt
```

经验 candidate 带上：

```text
policyId
updatedAt
decisionGuidance
```

去重规则：

```text
for each recalled experience:
  if experience.policyId in any recalledSkill.sourcePolicyIds:
    if recalledSkill.updatedAt >= experience.updatedAt:
      drop experience
    else:
      inject only experience's newer decision guidance
```

这样可以避免：

- prompt 同时注入 skill 和它的来源经验。
- skill 已经包含 Avoid 内容时，又重复注入同一条 Avoid。
- 新 feedback 更新了经验但 skill 尚未重建时，丢失最新避坑信息。

## 环境认知生成

环境认知仍然由多条经验生成，但经验类型可以是 mixed。

建议条件：

```text
至少 2 条 active 经验
同一环境/domain
每条 confidence >= 0.45
至少 1 条经验包含稳定环境事实或约束
```

环境认知可以吸收失败避坑经验，因为环境认知不是 skill，不要求“可执行成功路径”。失败经常能提供环境约束。

示例：

```text
经验 A success_pattern:
  SEC 13F task should parse all infoTable rows.

经验 B failure_avoidance:
  Do not reuse answers.json schema across SEC 13F tasks.

环境认知:
  SEC 13F family tasks share similar filing data, but each task has a distinct output schema. Verifier checks exact fields and values, so each round must confirm the requested schema before aggregating data.
```

需要补充 domain 识别。当前 `core/memory/l3/cluster.ts` 主要识别 docker、python、node 等工程域。建议增加 SEC 13F 相关关键词：

```text
13f
sec filing
cusip
infotable
holdings
accession
manager
issuer
aum
```

否则 SEC 13F 经验容易落入泛化 bucket，环境认知质量会差。

## SkillFlow 集成要求

SkillFlow runner 应满足：

1. 每个任务只跑一次，不重跑到成功。
2. 每个任务 verifier 后必须提交结构化 feedback。
3. verifier feedback 必须绑定到刚完成的 episode。
4. feedback prompt 或结构化 raw text 禁止包含 `换个任务`。
5. feedback 处理完成后，下一题开始前要 flush：
   - reward
   - feedback experience builder
   - skill crystallization
   - environment abstraction
6. 下一题 `turn.start` 应能召回上一题生成的避坑经验或成功经验。

建议在 `.test_skillflow_official_family` runner 中增加检查：

```text
after feedback:
  assert feedback row count increased
  assert experience count or decision guidance count changed when feedback is actionable
  assert next turn retrieval packet contains relevant SEC 13F experience when applicable
```

## 实施阶段

### Phase 1: 数据模型和 DTO

修改：

- `core/storage/migrations/*`
- `core/types.ts`
- `core/storage/repos/policies.ts`
- `agent-contract/dto.ts`
- `viewer/src/api/types.ts`

新增经验字段：

- `experienceType`
- `evidencePolarity`
- `salience`
- `confidence`
- `sourceFeedbackIds`
- `sourceTraceIds`
- `verifierMeta`
- `skillEligible`

### Phase 2: 反馈闭环

修改：

- `core/pipeline/memory-core.ts::submitFeedback`
- `core/reward/subscriber.ts`
- `core/feedback/subscriber.ts`
- `bridge/methods.ts`
- `server/routes/feedback.ts`

目标：

- `feedback.submit` 不只入库，还触发 reward、repair、feedback experience builder。
- 支持 late feedback：即使 episode 已关闭，也能重新评分并触发经验更新。

### Phase 3: Feedback Experience Builder

新增模块建议：

```text
core/experience/feedback-builder.ts
core/experience/classifier.ts
core/experience/merge.ts
core/experience/types.ts
```

职责：

- 解析显著反馈。
- 提炼 typed experience draft。
- 匹配已有经验。
- 创建或更新 `policies`。
- 写入 provenance。
- 发出 `experience.created` / `experience.updated` 事件。

### Phase 4: 经验召回

修改：

- `core/retrieval/retrieve.ts`
- `core/retrieval/types.ts`
- `core/retrieval/injector.ts`
- `core/storage/repos/policies.ts`

新增：

- `runExperienceRetrieval`
- 经验 candidate 类型
- typed experience renderer
- Avoid/Check/Do 分组注入

### Phase 5: Skill eligibility 增加成功锚点

修改：

- `core/skill/eligibility.ts`
- `core/skill/evidence.ts`
- `core/skill/crystallize.ts`
- `core/skill/packager.ts`

新增：

- `hasSuccessAnchor(policy)`
- `collectSupplementalAvoidance(policy)`
- skip reason: `no-success-anchor`

要求：

- `failure_avoidance` 经验可作为 counter example。
- `repair_instruction` 经验可作为 Check/Repair guidance。
- 只有 success anchor 可以作为 skill 主证据。

### Phase 6: 环境认知域识别

修改：

- `core/memory/l3/cluster.ts`
- `core/memory/l3/abstract.ts`

新增 SEC 13F domain tags，并允许 mixed polarity 经验进入环境认知生成。

### Phase 7: SkillFlow runner 验收

修改：

- `docs/SKILLFLOW_HERMES_EVAL.md`
- `.test_skillflow_official_family/run_sec13f_hermes_official.sh`
- 相关 verifier feedback helper

目标：

- verifier feedback 结构化提交。
- feedback 后检查经验/skill/环境认知变化。
- 下一题前确认召回包包含相关经验。

## 测试计划

新增或更新测试：

1. 失败 verifier feedback 生成 `failure_avoidance` 经验。
2. 有 expected/actual mismatch 的 verifier feedback 生成 `repair_instruction`。
3. 成功 verifier feedback 生成 `success_pattern`。
4. 只有普通负分 trace、没有显著反馈时，不生成经验。
5. 高 salience 负反馈生成可召回经验，但 `skill_eligible=false`。
6. 只有避坑经验时，skill eligibility 返回 `no-success-anchor`。
7. 成功经验 + 避坑经验时，可以生成 skill，且 Avoid 内容进入 skill。
8. skill 和其来源经验同时召回时，经验被去重。
9. 来源经验比 skill 更新时，只注入新增 decision guidance。
10. 两条 SEC 13F 相关经验生成环境认知。
11. SkillFlow 两题串跑：第一题失败反馈生成避坑经验，第二题 turn_start 能召回。

## 成功标准

在 SkillFlow SEC 13F family 上，至少满足：

1. 一轮失败 verifier feedback 后，记忆面板出现 typed 经验或已有经验被更新。
2. 下一轮同族任务开始时，召回 prompt 中包含上一轮避坑经验。
3. 避坑经验不会单独生成 skill。
4. 至少一轮成功经验出现后，系统可以用成功经验作为主证据，并合并失败避坑经验生成 skill。
5. 至少两条同域经验出现后，系统可以生成 SEC 13F 环境认知。

## 非目标

本优化不做以下事情：

1. 不把所有负分 trace 都纳入经验生成。
2. 不把 `l2Induction.minTraceValue` 全局调成负数。
3. 不把失败避坑经验单独结晶成 skill。
4. 不改变 SkillFlow 的“一题一次”测评语义。
5. 不要求同一道题反复重跑到成功。

核心原则：

> 失败反馈要沉淀为可召回的避坑经验，但 skill 必须由至少一条成功锚点支撑。失败经验可以帮助 skill 更稳，不能单独证明 skill 会成功。
