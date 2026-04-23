# 算法对齐检查

> 对照 `apps/memos-local-plugin/docs/Reflect2Skill_算法设计核心详解.md`
> 逐节检查 `memos-local-plugin` 的后端实现，列出：
>
> - ✅ **已实现**：代码结构与算法一致
> - ⚠️ **部分实现 / 有偏差**：功能在，但细节不达预期
> - ❌ **缺失**：算法文档要求但代码里没有
>
> 每一项都给出对应文件路径，便于后续逐项修补。

---

## §0 交互驱动的自我进化框架

### §0.1 步级决策过程 — L1 grounded trace

- ✅ 捕获 `(s_t, a_t, o_t, ρ_t)` — `core/capture/capture.ts`
  + `step-extractor.ts` + `reflection-extractor.ts`。
- ✅ 写 `traces` 表（schema 见 `storage/migrations/001-initial.sql`）。
- ⚠️ **反思合成**：算法要求 LLM 生成 ρ_t。当前实现有
  `capture/reflection-synth.ts`，默认 `capture.synthReflections = true`
  （已改过，见 commit 历史）。但 alpha 评分还依赖 reflection — 当 LLM
  缺席时会退化成 α=0，导致 V 全为 0。建议在 `alpha-scorer.ts` 的
  heuristic fallback 里至少给 α=0.3 的最低值。

### §0.2 任务级反馈 — 会话/回合关系分类

- ✅ `q_{k+1}` vs `q_k` 的 **revision / follow_up / new_task** 判定
  在 `core/session/relation.ts`（被 `orchestrator.ts::openEpisodeIfNeeded`
  调用）。
- ⚠️ 算法文档要求"修正型反馈回溯修正 $q_k$ 轮所有 traces 的 $V$"。代码里
  `reopenEpisode + addTurn` 追加 user turn，但重开的 episode 并不会把
  先前已 backprop 的 trace 重新回算 — reward subscriber 对 reopen 事件
  不敏感。**缺口**：修正发生时应对已 finalize 的 traces 重新做一次
  backprop（拿新的 `R_human` 覆盖旧 V）。

### §0.5 在线进化更新规则

- ✅ 每条 L1 写入触发增量 L2 关联 / 诱导：`memory/l2/subscriber.ts`
  监听 `reward.updated` 事件 → `runL2`。
- ✅ 多 L2 抽象 L3：`memory/l3/subscriber.ts`。
- ⚠️ 修订 / 降权：部分实现。`retrieval/recency.ts` 有按 priority
  降权，但没有明确的"L1 修订"入口——`updateTrace` 只能编辑文本和 tags，
  无法改 value。

### §0.6 反馈效用量化

- ✅ `reward/human-scorer.ts` 调 LLM 按 rubric 打分，落到 $R_{\text{human}} \in [-1, 1]$。
- ✅ `reward/backprop.ts` 做 reflection-weighted backprop：
  `V_t = α_t · R + (1-α_t) · γ · V_{t+1}`。
- ⚠️ 三个 axes（goalAchievement / processQuality / userSatisfaction）
  实现里都存在，但 UI 的 Analytics 页面没有把这三个维度拆开显示。
- ✅ 反思权重 α_t：`core/capture/alpha-scorer.ts`，有 LLM 评分 +
  heuristic 兜底。

### §0.6 Policy Gain

- ✅ $G(f^{(2)}) = \bar{V}_{\text{with}} - \bar{V}_{\text{without}}$
  在 `core/memory/l2/gain.ts::computeGain`，使用 softmax 加权。
- ⚠️ **首次 induction 的 gain 为负**（已修）：原代码在 `runL2` Step 4
  把新诱导 policy 的证据 trace 错误地归到 `withoutTraces`，导致首次
  gain 总是负的，policy 永远停在 candidate。**已在本次提交修复**
  （见 `l2.ts::inductionEvidenceByPolicy`）。

---

## §2 Skill 结晶与持续进化

### §2.1 Skill 字段完整性

算法文档要求的字段（`Skill:` YAML 示例）vs 当前 `SkillRow` / `SkillDTO`：

| 算法要求字段       | 对应实现字段             | 状态 |
|--------------------|--------------------------|------|
| `id`               | `id`                     | ✅   |
| `trigger`          | `invocationGuide` 里包含 | ⚠️  |
| `procedure`        | `invocationGuide` 里包含 | ⚠️  |
| `verification`     | `invocationGuide` 里包含 | ⚠️  |
| `scope`            | `invocationGuide` 里包含 | ⚠️  |
| `evidence_anchors` | —（依赖 `sourcePolicyIds`） | ❌ |
| `domain_model`     | `sourceWorldModelIds`    | ⚠️  |
| `decision_guidance.anti_pattern` | — | ❌ |
| `decision_guidance.preference`   | — | ❌ |
| `reliability.support_count` | `support`       | ✅   |
| `reliability.success_rate`  | —（只有 η）     | ❌ |
| `reliability.beta_posterior`| —               | ❌ |

**结论**：当前 Skill 的主体内容全部塞在 `invocationGuide: string` 里，
没有拆成结构化字段，所以 UI 没法单独展示 `decision_guidance`、
`evidence_anchors` 等；要让 Skill 抽屉支持这些，需要先扩 schema。

### §2.4.1 五层加工流水线

1. ✅ Trace extraction — `core/capture/*`
2. ✅ Value backfill — `core/reward/*`
3. ✅ Incremental L2 association / induction — `core/memory/l2/*`
4. ⚠️ Episode stitching — 当前靠 `session.followUpMode = "merge_follow_ups"`
   在 session/episode 层做粗拼接；没有"子任务级 episode"的概念。
5. ✅ Model abstraction + value-guided 降权 — `core/memory/l3/*` +
   `core/retrieval/recency.ts`

### §2.4.3 反向修订

- ⚠️ "改写 L1 + 回溯价值更新"：有 `updateTrace`（只改文本），没有
  "重新 backprop" 的入口。
- ⚠️ "修订 L2"：`setPolicyStatus` 可改 status、`upsert` 可改 body，
  但缺少一个原子方法"加条 boundary / 修 verification"。
- ⚠️ "修订 L3"：`adjustConfidence` 有，但不会用新反馈重跑
  `l3.abstraction` prompt。
- ⚠️ "修订 Skill"：`retireSkill` 有；`skill/evolver` 里有 rebuild
  分支（`skill.rebuilt` 事件已观测到）；但没有显式的 Repair / Shrink
  操作。

### §2.4.5 V 的五个用途

| 用途                       | 实现                                               | 状态 |
|----------------------------|----------------------------------------------------|------|
| ① 检索降权                 | `retrieval/recency.ts::applyRecencyDecay`          | ✅   |
| ② 检索排序                 | `retrieval/tier2-trace.ts` 按 V+priority 排序      | ✅   |
| ③ 策略归纳加权             | `memory/l2/similarity.ts::valueWeightedMean`       | ✅   |
| ④ Skill 可靠性 (η = G)     | `skill/packager.ts` 记录 η，但 η 实际取自 policy.gain | ⚠️ |
| ⑤ 决策指引生成             | —                                                  | ❌   |

**缺口 ⑤**：没有实现"同 context 下对比 V 分布生成 anti_pattern /
preference"。`core/feedback/*` 有 failure-burst 检测和 LLM repair
prompt，但只产出 `decision_repairs` 表记录，并没有反写到 Skill 的
`decision_guidance` 字段。

### §2.4.6 Decision Repair

- ⚠️ 表 `decision_repairs` 存在（见 `storage/migrations/001-initial.sql`
  及 `storage/repos/decision_repairs.ts`），`core/feedback/*` 在一定
  条件下会生成 repair，但：
  - 当前只在"同一工具连续失败 ≥ failureThreshold"时触发（burst 检测）
  - 没有算法文档里说的"同 context 下 $V$ 分布对比 > δ"触发路径
  - 生成的 repair 不会附加到任何 policy/skill — 存下来就完了
- ❌ 生成的 anti_pattern / preference 没有反注入到检索 prompt 里，
  所以 Agent 在后续 turn 感知不到自己的"吃一堑"教训。

---

## §3 检索与注入（Tier 1 / 2 / 3）

- ✅ Tier 1（Skill）：`retrieval/tier1-skill.ts`，按 η 阈值过滤。
- ✅ Tier 2（Trace / Episode）：`retrieval/tier2-trace.ts`，MMR +
  RRF，按 V + priority 排序。
- ✅ Tier 3（World model）：`retrieval/tier3-world.ts`，按 confidence
  过滤。
- ✅ MMR：`retrieval/mmr.ts`。
- ✅ RRF：`retrieval/rrf.ts`。
- ⚠️ "包含 decision_guidance 的 anti_pattern / preference" 注入：未实现
  （§2.4.6 同一问题）。

---

## 已修复

本次提交直接改的几处算法 bug：

1. **L2 首次 induction gain 为负 → 永久 candidate**
   - 文件：`core/memory/l2/l2.ts`
   - 原因：诱导的证据 trace 被错误归入 `withoutTraces`。
   - 修复：Step 4 同时吸收 `inductionEvidenceByPolicy` 的 trace，并
     把缺失的历史 trace 从 repo 补读。同时 `deltaSupport` 正确累计。
2. **L3 对 `policy.updated → active` 不敏感**
   - 文件：`core/memory/l3/subscriber.ts`
   - 原因：只订阅 `l2.policy.induced`。
   - 修复：新增对 `l2.policy.updated` 的订阅，在 status=active 时
     触发 `runL3`。
3. **任务轮次阈值缺失 → 单条消息也会被记成 completed**
   - 文件：`core/reward/reward.ts`
   - 新增 `minExchangesForCompletion` + `minContentCharsForCompletion`
     配置字段（默认 2 / 80），镜像旧项目的 `shouldSkipSummary`。
     未达阈值的 episode 不走打分，stamp 为 abandoned + reason。

---

## 建议后续迭代（按 ROI 排序）

1. **完整实现 Decision Repair 链路（§2.4.6 ⑤）**
   - 触发：Tier 2 结果里，同 context 且 V 分布对比 > δ
   - 产出：PolicyRow / SkillRow 新字段 `decisionGuidance: { antiPattern[], preference[] }`
   - 注入：`retrieval/injector.ts` 在 Tier 2 片段后追加
     `<anti_pattern>` / `<preference>` 段。
   - 影响：直接补齐算法文档 §2.4.6 的"吃一堑长一智"闭环。
2. **Skill schema 结构化拆分**
   - `SkillRow.invocationGuide: string` → 拆成 `trigger / procedure /
     verification / scope / domainModel / decisionGuidance` 多字段。
   - 前端 Skill 抽屉分段展示，避免"一坨 markdown"。
3. **Revision 型反馈触发 trace 回溯重算**
   - 在 `session/relation.ts` 识别 revision 后，派发
     `reward.rescheduled` 事件，reward subscriber 重新打分。
4. **Trace 手动编辑 value**
   - viewer Memories 抽屉加一个"标记为正/负样本"按钮，直接 PATCH
     `traces.value`，作为显式用户反馈输入。
5. **α_t heuristic 兜底**
   - 当没有 LLM 时给 α=0.3 最低值，避免 V 全 0。
