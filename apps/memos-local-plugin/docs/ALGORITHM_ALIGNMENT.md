# 算法对齐检查

> 对照 `apps/memos-local-plugin/docs/Reflect2Skill_算法设计核心.md`
> 逐节检查 `memos-local-plugin` 的后端 + 前端实现，列出：
>
> - ✅ **已实现**：代码 + UI 都跟得上
> - ⚠️ **部分实现 / 有偏差**：核心在，但闭环没合上、字段没显示、或细节走样
> - ❌ **缺失**：算法文档要求但代码里没有
>
> 每一项都给出对应文件路径行号，便于后续按 ROI 修复。
> 配套阅读：[`GRANULARITY-AND-MEMORY-LAYERS.md`](./GRANULARITY-AND-MEMORY-LAYERS.md)
> （术语 + 粒度 + 经验/环境认知/技能层级关系）。

---

## §0 交互驱动的自我进化框架

### §0.1 步级决策过程 — 步级记忆 (L1 grounded trace)

- ✅ 捕获 `(s_t, a_t, o_t, ρ_t)` — `core/capture/capture.ts` + `step-extractor.ts` + `reflection-extractor.ts`
- ✅ 写 `traces` 表（`storage/migrations/001-initial.sql`）
- ✅ 一个工具调用 = 一个 step；最终 assistant 回复 = 一个 step（`step-extractor.ts` sub-step 拆分）
- ✅ 同一用户消息引出的所有 sub-step 共享 `turn_id`，前端按 `(episodeId, turnId)` 聚合（migration 013 + `MemoriesView.buildGroups`）
- ⚠️ 反思合成：`capture/reflection-synth.ts` 默认开启，但 alpha 评分还依赖 reflection — LLM 缺席时会退化成 α=0，导致 V 全为 0。**建议**：`alpha-scorer.ts` heuristic fallback 至少给 α=0.3 最低值

### §0.2 任务级反馈 — 会话/回合关系分类

- ✅ `q_{k+1}` vs `q_k` 的 **revision / follow_up / new_task** 判定 — `core/session/relation-classifier.ts`
- ✅ revision → reopen episode；follow_up → 同 session 新 episode；new_task → 新 session — `pipeline/orchestrator.ts::onTurnStart`
- ❌ **revision 触发已 finalize traces 重新 backprop** — algorithm §0.2 / §2.4.3 要求"修正型反馈回溯修正 $q_k$ 轮所有 traces 的 $V$"，目前 reopen 事件不会触发新一轮 reward 计算。**缺口**：reopen 时应派发 `reward.rescheduled` 事件让 reward subscriber 用新的 `R_human` 覆盖旧 V

### §0.5 在线进化更新规则

- ✅ 每条新记忆写入触发增量经验关联：`memory/l2/subscriber.ts` 监听 `reward.updated` → `runL2`
- ✅ 多经验抽象环境认知：`memory/l3/subscriber.ts` 同时订阅 `l2.policy.induced` 和 `l2.policy.updated`（status=active 时）
- ✅ 检索按 priority 降权：`retrieval/recency.ts::applyRecencyDecay`
- ❌ **手动改 trace.value** — `updateTrace` 只能改 `summary / userText / agentText / tags`，前端无"标为正/负样本"按钮
- ⚠️ **修订入口分散**：经验有 `setPolicyStatus` + `upsert`、环境认知有 `adjustConfidence`、技能有 `archive` / `rebuild`，但没有原子的 "加一条 boundary / 改 verification" 操作

### §0.6 反馈效用量化

- ✅ `reward/human-scorer.ts` 调 LLM 按 rubric 打分，落到 $R_{\text{human}} \in [-1, 1]$
- ✅ 三 axes（goalAchievement / processQuality / userSatisfaction）实现都在
- ✅ `reward/backprop.ts` 反思加权回溯：`V_t = α_t · R + (1-α_t) · γ · V_{t+1}`
- ✅ 反思权重 α_t — `core/capture/alpha-scorer.ts`（LLM 评分 + heuristic 兜底）
- ⚠️ Analytics 页面没把 R_human 三 axes 拆开显示

### §0.6 Policy Gain

- ✅ $G(f^{(2)}) = \bar{V}_{\text{with}} - \tilde{V}_{\text{without}}$ — `core/memory/l2/gain.ts::computeGain`，with-set 用 softmax 加权（V7 §0.6 eq. 3），without-set 用 Bayesian shrinkage 把经验均值往中性 $V_0=0.5$ 收缩（pseudocount $N_0=5$）
- ✅ shrinkage 的工程动机：原始 V7 公式假设训练样本里有显式失败对照，但真实交互中绝大多数 episode 都成功，导致 $\bar{V}_{\text{without}} \approx \bar{V}_{\text{with}}$、$G \to 0$，所有 policy 永远卡在 candidate；中性先验保证有用 policy 在 $\bar{V}_{\text{with}} \approx 0.7$–$0.85$ 时拿到 $G \approx 0.05$–$0.20$ 正分；样本量足够后先验自然淡化
- ✅ 首次 induction gain 修复（详见末尾"已修复"小节）
- ✅ L2/L3/Skill 默认阈值同步下调以匹配新的 gain 分布：`l2.minTraceValue` 0.05→0.01、`l3.minPolicies` 3→2、`l3.minPolicyGain` 0.1→0.02、`skill.minGain` 0.1→0.02、`skill.candidateTrials` 5→3
- ✅ L3 cluster 二段式 admission（`core/memory/l3/cluster.ts`）：原 V7 §2.4.1 严格 cosine 形成 cluster 在 LLM 归纳出主题分散的 policy 时几乎无法成型；改成"严格优先 → 否则用整个 domain-key bucket 做 loose cluster"，并把 `cohesion ∈ [0,1]` 透传给 `abstract.ts`，对 loose cluster 的 confidence 做 0.6× ~ 1.0× 渐变降权。`PolicyCluster` 新增 `cohesion` + `admission: "strict"|"loose"` 两个字段

---

## §1 三层认知（小步 / 经验 / 环境认知）形式化对照

| 算法层 | 形式定义 | 实现行 / 文件 | 评价 |
|---|---|---|---|
| 小步 (L1) | $f^{(1)} = (s, a, o, \rho, r)$ | `core/types.ts::TraceRow` | ✅ 字段齐全 |
| 经验 (L2) | $f^{(2)} = (\phi, \pi, \kappa, \Omega, \{f^{(1)}\})$ | `core/types.ts::PolicyRow` | ⚠️ trigger/procedure/verification/boundary 都有；`{f^(1)}` 只到 episode 粒度（`sourceEpisodeIds`），**没有直接的 trace ids** |
| 环境认知 (L3) | $f^{(3)} = (\mathcal{E}, \mathcal{I}, \mathcal{C}, \{f^{(2)}\})$ | `core/types.ts::WorldModelRow` + `WorldModelStructure` | ✅ 完整 — `environment / inference / constraints` 三段式齐全；每条 entry 还有 `evidenceIds`（含 policy + trace ids） |

---

## §2 技能结晶与持续进化

### §2.1 Skill 字段完整性

算法文档要求的字段（`Skill:` YAML 示例）vs 当前 `SkillRow` + `procedureJson`（`SkillProcedure`）：

| 算法要求字段 | 对应实现 | 状态 |
|---|---|---|
| `id` | `SkillRow.id` | ✅ |
| `trigger` | `procedureJson.steps` 第一步 + `policy.trigger`（renderInvocationGuide 拼接） | ⚠️ 没单独字段，藏在 markdown 里 |
| `procedure` | `procedureJson.steps[]` | ✅ 结构化 |
| `verification` | — | ❌ Skill 没有独立 verification 字段（policy 有，但没传到 skill） |
| `scope` | `procedureJson.preconditions` | ⚠️ 部分 — preconditions 算前置条件，但没 `applies_to` / `not_applies_to` / `boundary` 三段式 |
| `evidence_anchors` (L1 trace 级) | `SkillRow.evidenceAnchors` (migration 014) + `SkillDTO.evidenceAnchors` | ✅ **已实现** — `packager.buildSkillRow` 持久化 `gatherEvidence` 返回的 trace ids（cap 10, best-first），SkillsView drawer 渲染点击跳 MemoriesView |
| `domain_model` (L3) | `sourceWorldModelIds` | ⚠️ 只存 id 数组，crystallize 时**不把 world model 内容传给 LLM 作 domain prior** |
| `decision_guidance.anti_pattern` | `procedureJson.decisionGuidance.antiPattern` | ✅ **已实现** — `SKILL_CRYSTALLIZE_PROMPT v2` 读 policy.boundary `@repair` 块 + counter examples，`packager.buildProcedure` 用 draft 数据填充（不再硬编码空） |
| `decision_guidance.preference` | `procedureJson.decisionGuidance.preference` | ✅ 同上 |
| `reliability.support_count` | `support` | ✅ |
| `reliability.success_rate` | — | ⚠️ 只有 `trialsAttempted / trialsPassed`，可推导但没暴露 |
| `reliability.beta_posterior` | — | ❌ |

**结论**：算法 §2.1 要求的核心字段已经基本就位 — `evidence_anchors`、`decision_guidance` 都从"硬编码空"修复为真正端到端落地（生成→持久化→DTO→前端显示）。剩余缺口收窄为：`domain_model` 内容传给 crystallize（只传了 id）、独立 `verification` 列、`reliability.success_rate / beta_posterior` 暴露。

### §2.4.1 五层加工流水线

| # | 算法步骤 | 实现 | 状态 |
|---|---|---|---|
| 1 | Trace extraction | `core/capture/*` | ✅ |
| 2 | Value backfill | `core/reward/*`（任务级 R_human + 反思加权回溯） | ✅ |
| 3 | 跨任务经验关联 / 诱导 | `core/memory/l2/*`（subscriber + induce + candidate_pool） | ✅ |
| 4 | Episode stitching（辅助） | `core/retrieval/tier2-trace.ts::rollupEpisodes` + `core/session/episode-manager.ts` | ✅ **旧 alignment 写错为 ⚠️**，实际实现完整 |
| 5 | Model abstraction + value-guided 降权 | `core/memory/l3/*` + `retrieval/recency.ts` | ✅ |

### §2.4.3 反向修订

- ⚠️ "改写小步 + 回溯价值更新"：`updateTrace` 只改文本，**没有重新 backprop 入口**
- ⚠️ "修订经验"：`setPolicyStatus` 改 status、`upsert` 改 body，但没"加 boundary / 改 verification" 的原子方法
- ⚠️ "修订环境认知"：`adjustConfidence` 调 confidence，但**不会用新反馈重跑 `l3.abstraction` prompt**
- ⚠️ "修订技能"：`retireSkill` ✅ + `skill/skill.ts` rebuild 分支 ✅，但没显式的 "Repair / Shrink" 路径

### §2.4.5 V 的五个用途

| # | 用途 | 实现 | 状态 |
|---|---|---|---|
| ① | 检索降权 | `retrieval/recency.ts::applyRecencyDecay` | ✅ |
| ② | 检索排序 | `retrieval/tier2-trace.ts` 按 V+priority 排序 | ✅ |
| ③ | 策略归纳加权 | `memory/l2/similarity.ts::valueWeightedMean`（softmax(V/τ)） | ✅ |
| ④ | Skill 可靠性 (η) | `skill/packager.ts::deriveInitialEta` 从 policy.gain + support 推导 | ⚠️ η 在 packager 里基于 policy.gain 推导；trial 期更新 η 走 `lifecycle.ts::updateEta`。**没暴露 success_rate / beta** |
| ⑤ | 决策指引生成 | `core/feedback/*` | ⚠️ **生成有，闭环没合上**（详见 §2.4.6） |

### §2.4.6 Decision Repair —— 算法核心闭环之一

| 环节 | 实现 | 状态 |
|---|---|---|
| Burst 触发（同工具连续失败 ≥ threshold） | `core/feedback/feedback.ts` | ✅ |
| 用户文本触发（"不对 / 应该 X / 不要 Y"） | `core/feedback/classifier.ts` | ✅ |
| **算法要求的"同 context 下 V 分布对比 > δ"触发** | — | ❌ 没实现这条触发路径 |
| LLM 合成 anti_pattern + preference | `core/feedback/synthesize.ts` + `core/llm/prompts/decision-repair.ts` | ✅ |
| Heuristic fallback（最高/最低 V 取 reflection） | `synthesize.ts::templateDraft` | ✅ |
| 写入 `decision_repairs` 表 | `core/storage/repos/decision_repairs.ts` | ✅ |
| **挂到 PolicyRow** | `feedback.ts::attachRepairToPolicies` 把 `{preference, antiPattern}` 塞进 `policy.boundary` 的 `@repair {…}` JSON 块 | ⚠️ 工作但是 hack — 应该是独立列 |
| PolicyDTO 透出 preference / antiPattern | `memory-core.ts::parsePolicyGuidanceBlock` | ✅ |
| PoliciesView 显示 | `viewer/src/views/PoliciesView.tsx:243-256, 497-518` | ✅ |
| **写入 SkillRow.procedureJson.decisionGuidance** | `core/skill/packager.ts::buildProcedure` | ✅ **已实现** — 用 draft.decisionGuidance 替换原硬编码空 |
| **Skill crystallize prompt 输入 policy 的 @repair** | `core/llm/prompts/skill-crystallize.ts v2` + `crystallize.ts::packPrompt::parseRepairBlock` | ✅ **已实现** — 把 `@repair {…}` 提到 `repair_hints`，加上 `counter_examples` 一起喂给 LLM |
| **SkillsView 显示 decisionGuidance** | `viewer/src/views/SkillsView.tsx::SkillDrawer` | ✅ **已实现** — drawer 新增 "Decision guidance (prefer / avoid)" 段，列出双数组 |
| **retrieval/injector 把 decision_guidance 注入到 agent prompt** | `core/retrieval/decision-guidance.ts::collectDecisionGuidance` + `injector.ts::renderDecisionGuidance` | ✅ **已实现** — retrieval 拉 active policies, 按 `sourceEpisodeIds` 与召回的 trace 关联, 解析 `@repair` 块, 在注入包尾部渲染 "## Decision guidance" 段 |

→ **决策修复链路完整闭环**：repair 的 preference / anti-pattern 三处都消费了：① 写入到 Skill 的 `decisionGuidance` 字段并随技能注入；② retrieval 时按 episode-policy 关联从 active policies 临时召回，独立成段注入到 agent prompt；③ PoliciesView + SkillsView 都展示。Agent 现在真正能感知到"吃一堑长一智"的教训。

---

## §2.5 技能结晶五步

| Step | 算法描述 | 实现 | 状态 |
|---|---|---|---|
| 0 | 收集 Support Set（正例 / 反例 / 边界样本） | `core/skill/evidence.ts::gatherEvidence` 取高 V trace 作正例 | ⚠️ **只取正例**，没区分反例（V<0）和边界样本（V≈0）。算法要求三类 |
| 0 | L3 作为 domain prior | — | ❌ crystallize 不接收 sourceWorldModelIds 对应的 worldModel 内容 |
| 1 | LLM 诱导草案 | `core/skill/crystallize.ts` + `SKILL_CRYSTALLIZE_PROMPT` | ✅ |
| 2 | 结构化解析 → ϕ/π/κ/η 四元组 | `crystallize.ts::normaliseDraft` + `packager.ts::buildSkillRow` | ⚠️ ϕ trigger 没单独字段；κ verification 完全缺失 |
| 3 | 双重检验 — 一致性检验 | `core/skill/verifier.ts`（coverage + resonance） | ✅ |
| 3 | 双重检验 — 执行增益检验（小规模实际部署） | — | ❌ 算法要求"在后续任务中实际部署 + 对比"，目前只有被动 `trialsAttempted/passed` 计数 |
| 4 | Active vs Probationary | `core/skill/lifecycle.ts` | ✅ |
| 5 | 结晶后持续修订（强化 / Repair / Shrink / Retire / Rebuild） | `lifecycle.ts` 有 strengthen / archive；`skill.ts` 有 rebuild 分支 | ⚠️ 缺显式 Repair / Shrink |

---

## §2.6 三层检索

- ✅ Tier 1（技能）：`retrieval/tier1-skill.ts`，按 η 阈值过滤
- ✅ Tier 2a（单步记忆）：`retrieval/tier2-trace.ts`，三路并行（structural / semantic / pattern / FTS），RRF 融合
- ✅ Tier 2b（子任务序列回放）：`retrieval/tier2-trace.ts::rollupEpisodes`（按 episode_id 拼接）
- ✅ Tier 3（环境认知）：`retrieval/tier3-world.ts`，按 confidence + 领域标签
- ✅ MMR：`retrieval/mmr.ts`
- ✅ RRF：`retrieval/rrf.ts`
- ❌ **decision_guidance 注入**（§2.4.6 闭环断点）— 在 Tier 2 片段后追加 `<anti_pattern>` / `<preference>` 段未实现

---

## §3 evidence 全栈追踪能力对照

> 这是用户专门问到的"evidence 是否实现 + 用在哪"，单独成节。

| 起点 | 能否找到底层 trace 证据？ | 通过什么字段 / API |
|---|---|---|
| 一条 L2 经验 | ⚠️ 只能找到 episode（不到 trace） | `PolicyRow.sourceEpisodeIds` → 然后枚举每个 episode 的 traces。**candidate_pool 在诱导阶段持有过具体 trace ids 但消费完就清** |
| 一条 L3 环境认知 | ✅ **每条 entry 直接挂 trace + policy ids** | `WorldModelStructureEntry.evidenceIds` |
| 一条技能 | ✅ **直接挂 trace ids**（migration 014） | `SkillRow.evidenceAnchors: TraceId[]` — packager 落 `gatherEvidence` 输出，cap 10，best-first |

**前端显示**：
- L2 PoliciesView：✅ 显示来源 episode 列表
- L3 WorldModelsView：✅ 显示来源 policy 列表 + ✅ **entry 级 evidenceIds chips**（含 trace + policy 跳转）
- Skill SkillsView：✅ 显示 source policy + source world model 跳转 chip + ✅ **trace 级 evidence anchors 跳 MemoriesView**

**LLM prompt 是否要求输出 evidence？**
- L2 induction prompt（v2）：✅ 输出 `support_trace_ids`（但**没存到 PolicyRow**，仍是一处小缺口）
- L3 abstraction prompt（v2）：✅ 输出 `evidenceIds` per entry，**已存进 `WorldModelStructure`** + UI 渲染
- Skill crystallize prompt（v2）：✅ 不要求 LLM 输出（packager 直接持久化 `gatherEvidence` 的输出）+ ✅ 持久化到 `SkillRow.evidenceAnchors`

---

## 已修复（本仓库历史）

1. **L2 首次 induction gain 为负 → 永久 candidate**（`core/memory/l2/l2.ts`）
2. **L3 对 `policy.updated → active` 不敏感**（`core/memory/l3/subscriber.ts`）
3. **任务轮次阈值缺失 → 单条消息也会被记成 completed**（`core/reward/reward.ts` + `minExchangesForCompletion` / `minContentCharsForCompletion`）
4. **多工具调用之间的"思考"丢失**（`adapters/openclaw/bridge.ts` thinkingBefore + 持久化进 `tool_calls_json`）
5. **状态术语统一**（`probationary/retired` → `candidate/archived`，policies / skills / world_model 统一） — 已固化进 `001-initial.sql`
6. **trace.turn_id 列**（前端"一轮一卡"聚合用，算法层不可见） — 已固化进 `001-initial.sql`
7. **prompt v2** — L2 / L3 加 boundary 守卫，明确禁止"经验越界写成环境事实 / 环境认知越界写成动作建议"
8. **Decision guidance 全链路闭环**（V7 §2.4.6）：
   - retrieval/injector 新增 "Decision guidance" 段（`core/retrieval/decision-guidance.ts` + `injector.ts::renderDecisionGuidance`）
   - Skill crystallize prompt v2 读 policy `@repair` + counter examples
   - packager 真正落地 `procedureJson.decisionGuidance`（不再硬编码空）
   - SkillsView drawer 加 "Decision guidance" 段
9. **Skill `evidence_anchors` 持久化 + 显示**（V7 §2.1）：
   - `skills.evidence_anchors_json` 列（已固化进 `001-initial.sql`）
   - SkillRow + SkillDTO 加 `evidenceAnchors: TraceId[]`
   - SkillsView drawer 渲染 trace chip 跳 MemoriesView
10. **L3 entry 级 evidenceIds 前端渲染**（V7 §1.1）：
   - WorldModelDTO 暴露 `structure: { environment, inference, constraints }` 三段式
   - WorldModelsView drawer 加 `<StructureSection>` 每个 entry 显示 evidence chips（trace 跳 MemoriesView，policy 跳 PoliciesView）

---

## 建议后续迭代（按 ROI 排序）

### 高 ROI（剩余闭环缺口）

1. **revision 反馈触发 trace 回溯重算** — 算法 §0.2 / §2.4.3 核心
   - relation classifier 识别 revision 后，派发 `reward.rescheduled` 事件
   - reward subscriber 重新打分，覆盖旧 V
   - 影响：用户说"不对"时，整轮 trace 的 V 真的会被新的 R_human 覆盖（目前 reopen 后还是旧 V）

2. **Skill crystallize 接收 L3 world model 作 domain prior** — 算法 §2.5 step 1
   - `packPrompt` 加载 `policy.sourceEpisodeIds → world_models referencing those policies` 的 body 段
   - prompt schema 加 `domain_model: string` 输出字段
   - `packager` 持久化到 `procedureJson.domainModel`

3. **L2 induction 持久化 `support_trace_ids`** — 当前已经 LLM 输出但没存
   - PolicyRow 加 `evidenceAnchors: TraceId[]` 列（新建 `002-policy-evidence-anchors.sql`）
   - `induce.ts` 把 LLM 返回的 `support_trace_ids` 落进字段
   - PoliciesView drawer 加 trace 跳转 chip

### 中 ROI

4. **Trace 手动改 value（"标为正/负样本"）** — 算法 §2.4.5
   - 后端：`updateTrace` 接受 `value` patch（带 audit 字段）
   - 前端：MemoriesView 抽屉加按钮

5. **Decision repair "同 context 下 V 分布对比" 触发路径** — §2.4.6 三种触发的最后一种
   - 现在只有 burst + 用户文本两种触发；算法还要求"V 分布差 > δ"自动触发
   - 实现：`feedback/subscriber.ts` 监听 `reward.updated`，对刚收尾的 episode 跑一次 V 分布对比

### 低 ROI

6. **α_t heuristic 兜底**：LLM 缺席时 α 至少 0.3
7. **Analytics 页面 R_human 三 axes 拆开显示**
8. **Skill verification / scope 字段单独拆出**（不再藏在 invocationGuide markdown 里）
9. **Skill 主动小规模 A/B 试用**（把 trial 从被动累计改成主动派发）
10. **Skill `reliability.beta_posterior / success_rate` 暴露到 DTO + UI**
