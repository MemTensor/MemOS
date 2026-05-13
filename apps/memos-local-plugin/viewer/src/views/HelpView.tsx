/**
 * Help view — concept guide + per-field reference.
 *
 * Two narratives live side by side:
 *
 *  1. Concept walk-through (top half) — why MemOS Local exists, the
 *     four memory-asset layers it produces, the dual feedback loop
 *     it learns from, and how a new task pulls from each layer at
 *     retrieval time. This mirrors the launch-2.0 deck so users see
 *     the same story inside the panel — but rebuilt with the
 *     viewer's tokens (--cyan / --amber / --green / --violet …) so
 *     it reads as part of the dashboard, not a marketing page.
 *
 *  2. Field reference (bottom half) — every metadata column on
 *     Memories / Tasks / Skills / Experiences / Environment
 *     Knowledge so users can look up an unfamiliar number without
 *     leaving the panel.
 */
import { locale } from "../stores/i18n";
import { Icon, type IconName } from "../components/Icon";

interface HelpField {
  label: string;
  desc: string;
  hint?: string;
}

interface HelpSection {
  icon: IconName;
  title: string;
  intro?: string;
  fields: HelpField[];
  /**
   * Layer accent — pinned to the same memory / experience / env-
   * knowledge / skill colour the concept guide above uses, so the
   * reader can pattern-match section icons across the two halves.
   */
  layer?: "memory" | "experience" | "envKn" | "skill" | "task";
}

/**
 * Stable per-layer colour map. The same four layers are referenced
 * by the pyramid, the pipeline, and the retrieval tier card so they
 * MUST share their accent colours — switching to a one-off palette
 * inside any of those sections breaks the visual link the page
 * relies on.
 */
const LAYER = {
  memory:     { color: "var(--cyan)",   bg: "var(--cyan-bg)" },
  experience: { color: "var(--amber)",  bg: "var(--amber-bg)" },
  envKn:      { color: "var(--green)",  bg: "var(--green-bg)" },
  skill:      { color: "var(--violet)", bg: "var(--violet-bg)" },
} as const;

function getSections(isZh: boolean): HelpSection[] {
  return [
    {
      icon: "brain-circuit",
      title: isZh ? "记忆" : "Memories",
      layer: "memory",
      intro: isZh
        ? "记忆页展示每一步执行的原始记录。每条记忆带有系统自动回填的数值信号，代表这条记忆的重要性和权重。"
        : "The Memories page shows the raw trace of every execution step. Each memory carries system-backfilled numerical signals representing its importance and weight.",
      fields: [
        {
          label: isZh ? "价值 V" : "Value V",
          hint: "[-1, 1]",
          desc: isZh
            ? "这条记忆对任务成功的贡献程度。正值 = 有帮助，负值 = 反例；绝对值越大权重越大。"
            : "How much this memory contributed to task success. Positive = helpful, negative = counterexample; larger absolute value = higher weight.",
        },
        {
          label: isZh ? "反思权重 α" : "Reflection weight α",
          hint: "[0, 1]",
          desc: isZh
            ? "这一步反思的质量。识别出关键发现的步骤 α 高（0.6–0.8），正常推进中等（0.3–0.5），盲目试错低（0–0.2）。"
            : "Quality of this step's reflection. Steps with key findings have high α (0.6–0.8), normal progress is medium (0.3–0.5), blind trial-and-error is low (0–0.2).",
        },
        {
          label: isZh ? "用户反馈分 R_human" : "User feedback R_human",
          hint: "[-1, 1]",
          desc: isZh
            ? "用户对整个任务的满意度评分。只在用户给出明确反馈后才会出现。"
            : "User satisfaction score for the entire task. Only appears after explicit user feedback.",
        },
        {
          label: isZh ? "优先级" : "Priority",
          desc: isZh
            ? "检索排序权重。价值高且较新的记忆优先级高、被召回的机会更大；老旧或低价值记忆自然下沉但不会被删除。"
            : "Retrieval sort weight. High-value recent memories rank higher and are more likely to be recalled; old or low-value memories naturally sink but are never deleted.",
        },
        {
          label: isZh ? "本任务的其他步骤" : "Other steps in this task",
          desc: isZh
            ? "同一个任务下，按时间顺序排列的其他步骤记忆。"
            : "Other step memories under the same task, ordered chronologically.",
        },
      ],
    },
    {
      icon: "list-checks",
      title: isZh ? "任务" : "Tasks",
      layer: "task",
      intro: isZh
        ? "任务页展示每一段聚焦的对话（一次完整的问→答过程）。点击可以看到完整对话和对应的技能流水线进度。"
        : "The Tasks page shows each focused conversation (a complete Q→A session). Click to see the full dialogue and its skill pipeline progress.",
      fields: [
        {
          label: isZh ? "状态" : "Status",
          desc: isZh
            ? "进行中 / 已完成 / 已跳过 / 失败。已跳过 = 对话过短无法形成有效记忆。失败 = 评分为负，本任务的记录会作为反例保留。"
            : "In progress / Completed / Skipped / Failed. Skipped = conversation too short to form valid memories. Failed = negative score, records kept as counterexamples.",
        },
        {
          label: isZh ? "技能流水线" : "Skill pipeline",
          desc: isZh
            ? "代表本任务在技能结晶流水线上的状态：等待中 / 生成中 / 已生成 / 已升级 / 未达沉淀阈值。"
            : "This task's status in the skill crystallization pipeline: Pending / Generating / Generated / Upgraded / Below threshold.",
        },
        {
          label: isZh ? "任务评分 R_task" : "Task score R_task",
          desc: isZh
            ? "用户满意度的数值化表达。正值越大 = 越满意。"
            : "Numerical expression of user satisfaction. Higher positive value = more satisfied.",
        },
        {
          label: isZh ? "对话轮次" : "Turns",
          desc: isZh
            ? "本任务的问答轮数。"
            : "Number of Q&A turns in this task.",
        },
      ],
    },
    {
      icon: "wand-sparkles",
      title: isZh ? "技能" : "Skills",
      layer: "skill",
      intro: isZh
        ? "技能是从经验中结晶出来的可调用能力。当新任务到来时，系统会自动匹配最相关的技能并注入给助手。"
        : "Skills are callable abilities crystallized from experiences. When a new task arrives, the system automatically matches the most relevant skills and injects them into the assistant.",
      fields: [
        {
          label: isZh ? "状态" : "Status",
          desc: isZh
            ? "已启用 = 已通过验证可被调用；候选 = 还在等待更多证据；已归档 = 已停用不参与检索。"
            : "Active = verified and callable; Candidate = awaiting more evidence; Archived = disabled, excluded from retrieval.",
        },
        {
          label: isZh ? "可靠性 η" : "Reliability η",
          desc: isZh
            ? "调用这条技能比不调用时的平均效果提升。η 越高越值得调用。"
            : "Average performance improvement when invoking this skill vs. not. Higher η = more worth invoking.",
        },
        {
          label: isZh ? "增益 gain" : "Gain",
          desc: isZh
            ? "结晶时统计的策略平均收益。"
            : "Average strategic return computed during crystallization.",
        },
        {
          label: isZh ? "支撑任务数 support" : "Support count",
          desc: isZh
            ? "有多少个独立任务支撑了这条技能。"
            : "Number of independent tasks that support this skill.",
        },
        {
          label: isZh ? "版本 version" : "Version",
          desc: isZh
            ? "每次重建 +1。"
            : "Increments by 1 on each rebuild.",
        },
        {
          label: isZh ? "进化时间线" : "Evolution timeline",
          desc: isZh
            ? "记录技能生命周期：开始结晶 → 结晶完成 → 重建 → η 更新 → 状态变更 → 归档。"
            : "Records the skill lifecycle: start crystallization → crystallization complete → rebuild → η update → status change → archive.",
        },
      ],
    },
    {
      icon: "sparkles",
      title: isZh ? "经验" : "Experiences",
      layer: "experience",
      intro: isZh
        ? "经验是从多个相似任务中归纳出的可复用策略。它不直接注入给助手，而是通过结晶成技能后间接生效。"
        : "Experiences are reusable strategies induced from multiple similar tasks. They don't inject into the assistant directly but take effect indirectly after crystallizing into skills.",
      fields: [
        {
          label: isZh ? "触发 trigger" : "Trigger",
          desc: isZh
            ? "在什么场景下应该启用这条经验。"
            : "Under what scenario this experience should be activated.",
        },
        {
          label: isZh ? "流程 procedure" : "Procedure",
          desc: isZh
            ? "应该执行什么步骤。"
            : "What steps should be executed.",
        },
        {
          label: isZh ? "验证 verification" : "Verification",
          desc: isZh
            ? "怎么判断这条经验是否被成功执行。"
            : "How to determine if this experience was successfully applied.",
        },
        {
          label: isZh ? "边界 boundary" : "Boundary",
          desc: isZh
            ? "适用范围和排除范围。"
            : "Applicable scope and exclusions.",
        },
        {
          label: isZh ? "支撑任务数 / 增益" : "Support count / Gain",
          desc: isZh
            ? "支撑的独立任务数和平均价值增益。用于决定是否结晶为技能。"
            : "Number of supporting independent tasks and average value gain. Used to decide whether to crystallize into a skill.",
        },
        {
          label: isZh ? "决策指引（推荐做法 / 避免做法）" : "Decision guidance (do / avoid)",
          desc: isZh
            ? "系统从用户反馈中提取的行动建议。同一场景下不同做法的效果显著分化时，自动生成「优先做 X，避免做 Y」。"
            : "Action recommendations extracted from user feedback. When different approaches in the same scenario show significant divergence, the system auto-generates 'prefer X, avoid Y'.",
        },
      ],
    },
    {
      icon: "globe",
      title: isZh ? "环境认知" : "Environment Knowledge",
      layer: "envKn",
      intro: isZh
        ? "环境认知是系统对你工作环境的压缩理解。有了它，助手可以直接凭记忆导航而不必每次重新探索。"
        : "Environment knowledge is the system's compressed understanding of your working environment. With it, the assistant can navigate from memory without re-exploring every time.",
      fields: [
        {
          label: isZh ? "空间结构" : "Spatial structure",
          desc: isZh
            ? "环境中什么东西在哪 — 目录、服务拓扑、配置文件位置等。"
            : "What's where in the environment — directories, service topology, config file locations, etc.",
        },
        {
          label: isZh ? "行为规律" : "Behavioral patterns",
          desc: isZh
            ? "环境对动作的典型响应 — 如「这个 API 返回 JSON」「构建必须先 compile 再 link」。"
            : "Typical environment responses to actions — e.g. 'this API returns JSON', 'build must compile then link'.",
        },
        {
          label: isZh ? "约束与禁忌" : "Constraints & taboos",
          desc: isZh
            ? "什么不能做 — 如「这个目录是只读的」「Alpine 上别用 binary wheel」。"
            : "What must not be done — e.g. 'this directory is read-only', 'don't use binary wheels on Alpine'.",
        },
        {
          label: isZh ? "关联经验数" : "Related experience count",
          desc: isZh
            ? "支撑这条认知的经验数量。数量越多说明该结构越稳定。"
            : "Number of experiences supporting this knowledge entry. More = more stable structure.",
        },
      ],
    },
  ];
}

export function HelpView() {
  const isZh = locale.value === "zh";
  const SECTIONS = getSections(isZh);
  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{isZh ? "帮助" : "Help"}</h1>
          <p>
            {isZh
              ? "先了解 MemOS 是什么、AI 在如何持续学习你的世界；再速查面板里每个数值与状态的含义。"
              : "First, see what MemOS is and how the AI keeps learning about your world. Then look up what every score and status in the panel means."}
          </p>
        </div>
        <div class="view-header__actions">
          <a
            class="btn btn--ghost btn--sm"
            href="https://github.com/MemTensor/MemOS"
            target="_blank"
            rel="noreferrer noopener"
          >
            <Icon name="github" size={14} />
            GitHub
          </a>
        </div>
      </div>

      {/*
       * ── PART 1 · Concept guide ─────────────────────────────────
       *
       * Mirrors the launch-2.0 narrative arc (problem → insight →
       * pipeline → assets → dual-feedback → mechanisms → retrieval)
       * but sized down for an in-app reference. Each block is a
       * small self-contained component below so readers can drop
       * into any single section without scrolling state.
       */}
      <SectionDivider />

      <CoreConceptHero isZh={isZh} />
      <ArchitectureDiagram isZh={isZh} />
      <PainPoints isZh={isZh} />
      <LearningPipeline isZh={isZh} />
      <MemoryAssets isZh={isZh} />
      <DualFeedback isZh={isZh} />
      <CoreMechanisms isZh={isZh} />
      <ThreeTierRetrieval isZh={isZh} />

      {/*
       * ── PART 2 · Field reference ────────────────────────────────
       *
       * Per-page glossaries. Lives below the concept guide because
       * users tend to land here from a question like "what does α
       * mean?" — they want the definition, not the philosophy. The
       * concept guide above is for first-time onboarding.
       */}
      <SectionDivider topMargin />

      {/* Per-section field docs */}
      <div class="vstack" style="gap:var(--sp-5)">
        {SECTIONS.map((sec) => {
          const accent =
            sec.layer && sec.layer !== "task" ? LAYER[sec.layer] : null;
          const accentColor = accent?.color ?? "var(--accent)";
          const accentBg = accent?.bg ?? "var(--accent-soft)";
          return (
            <section
              class="card"
              key={sec.title}
              style={`border-left:3px solid ${accentColor}`}
            >
              <div
                class="card__header"
                style="margin-bottom:var(--sp-4);align-items:center"
              >
                <div class="hstack" style="gap:var(--sp-3);align-items:center">
                  <span
                    style={`display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;background:${accentBg};color:${accentColor};flex-shrink:0`}
                  >
                    <Icon name={sec.icon} size={18} />
                  </span>
                  <div>
                    <h3 class="card__title" style="margin:0">
                      {sec.title}
                    </h3>
                    {sec.intro && (
                      <p
                        class="card__subtitle"
                        style="margin:4px 0 0 0;max-width:780px"
                      >
                        {sec.intro}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <dl
                style="display:grid;grid-template-columns:280px 1fr;gap:0 var(--sp-5);margin:0;font-size:var(--fs-sm);line-height:1.6"
              >
                {sec.fields.map((f, idx) => (
                  <>
                    <dt
                      key={`dt-${f.label}`}
                      style={`display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-weight:var(--fw-semi);color:var(--fg);padding:${idx === 0 ? "0" : "var(--sp-3)"} 0 var(--sp-3) 0;${idx > 0 ? "border-top:1px solid var(--border);" : ""}`}
                    >
                      <span>{f.label}</span>
                      {f.hint && (
                        <span
                          class="mono"
                          style={`font-size:var(--fs-2xs);font-weight:var(--fw-bold);color:${accentColor};background:${accentBg};padding:1px 7px;border-radius:var(--radius-sm);white-space:nowrap;letter-spacing:.02em`}
                        >
                          {f.hint}
                        </span>
                      )}
                    </dt>
                    <dd
                      key={`dd-${f.label}`}
                      style={`margin:0;color:var(--fg-muted);padding:${idx === 0 ? "0" : "var(--sp-3)"} 0 var(--sp-3) 0;${idx > 0 ? "border-top:1px solid var(--border);" : ""}`}
                    >
                      {f.desc}
                    </dd>
                  </>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Concept-guide sub-components
 *
 * Each helper renders one explainer block. They share a common
 * "section heading + supporting visual" rhythm so the page reads
 * top-to-bottom as one document instead of a stack of unrelated
 * cards. Section spacing comes from `margin-bottom: var(--sp-5)` on
 * the outermost element (mirrors the field-reference cards above).
 * ──────────────────────────────────────────────────────────────── */

/**
 * Plain horizontal rule used between the page's two halves.
 *
 * Earlier versions paired a numbered chip with a label/subtitle so
 * the page felt branded ("01 · 概念导览", "02 · 字段速查"). We've
 * since dropped that text — the page reads cleanly enough without
 * it, and the labels were forcing maintenance churn (product name
 * not finalised, version numbers etc.). Now it's just a single
 * 1px rule that adapts to the current theme via `var(--border)`.
 */
function SectionDivider({ topMargin }: { topMargin?: boolean }) {
  return (
    <div
      role="separator"
      aria-hidden="true"
      style={`height:1px;background:var(--border);margin:${topMargin ? "var(--sp-7)" : "var(--sp-2)"} 0 var(--sp-4)`}
    />
  );
}

/**
 * Hero — the one sentence that answers "what is this thing?"
 *
 * Borrows the launch deck's headline ("execution as learning") plus
 * its three input → output equation, but rendered inside a normal
 * `.card` with an accent left rail so it visually anchors the page
 * instead of fighting the dashboard surface.
 */
function CoreConceptHero({ isZh }: { isZh: boolean }) {
  return (
    <section
      class="card"
      style="margin-bottom:var(--sp-5);padding:var(--sp-6);position:relative;overflow:hidden"
    >
      {/* Subtle accent wash in the upper-right — a single decorative
          flourish on the page so the hero clearly anchors part 1. */}
      <div
        style="position:absolute;top:0;right:0;width:240px;height:240px;background:radial-gradient(circle at top right,var(--accent-soft),transparent 65%);pointer-events:none"
        aria-hidden="true"
      />
      <div
        style="position:relative;display:grid;grid-template-columns:auto 1fr;gap:var(--sp-4);align-items:flex-start;margin-bottom:var(--sp-4)"
      >
        <span
          style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:12px;background:var(--accent);color:var(--accent-fg);box-shadow:var(--shadow-sm)"
        >
          <Icon name="zap" size={22} />
        </span>
        <div>
          <div
            class="mono"
            style="font-size:var(--fs-2xs);font-weight:var(--fw-bold);color:var(--accent);letter-spacing:.18em;margin-bottom:6px"
          >
            {isZh ? "核心理念 · CORE IDEA" : "CORE IDEA"}
          </div>
          <h3
            class="card__title"
            style="margin:0 0 8px 0;font-size:var(--fs-xl);letter-spacing:-.01em"
          >
            {isZh
              ? "执行即学习 · 让 AI 在做事时持续学会你的世界"
              : "Execution as learning — the AI learns your world while doing the work"}
          </h3>
          <p
            class="card__subtitle"
            style="margin:0;max-width:720px;line-height:1.7"
          >
            {isZh
              ? "通用大模型已经会思考世界，但对你的项目、环境、偏好一无所知。MemOS Local 让 AI 在为你做事时，把每一步都「学进去」 —— 不重训大模型，而是把执行链路沉淀为可复用的长期记忆。"
              : "General LLMs can reason about the world, but they know nothing about your project, environment or preferences. MemOS Local lets the AI learn from every step it takes for you — not by retraining the model, but by turning each execution into reusable long-term memory."}
          </p>
        </div>
      </div>

      <div
        style="position:relative;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:10px;padding:var(--sp-4) var(--sp-3);background:var(--bg-canvas);border:1px solid var(--border);border-radius:var(--radius-md)"
      >
        <HeroTerm label={isZh ? "通用大模型" : "General LLM"} />
        <HeroOp sym="+" />
        <HeroTerm label={isZh ? "你的环境" : "Your environment"} />
        <HeroOp sym="+" />
        <HeroTerm label={isZh ? "你的反馈" : "Your feedback"} />
        <HeroOp sym="=" emphasis />
        <span
          style="display:inline-flex;align-items:center;padding:7px 16px;border-radius:var(--radius-pill);background:var(--accent);color:var(--accent-fg);font-size:var(--fs-sm);font-weight:var(--fw-bold);box-shadow:var(--shadow-sm);white-space:nowrap"
        >
          {isZh ? "完全对齐你的 AI" : "An AI fully aligned to you"}
        </span>
      </div>
    </section>
  );
}

function HeroTerm({ label }: { label: string }) {
  return (
    <span
      style="display:inline-flex;align-items:center;padding:5px 14px;border-radius:var(--radius-pill);background:var(--bg-elev-1);border:1px solid var(--border);color:var(--fg);font-size:var(--fs-xs);font-weight:var(--fw-semi);white-space:nowrap"
    >
      {label}
    </span>
  );
}

function HeroOp({ sym, emphasis }: { sym: string; emphasis?: boolean }) {
  return (
    <span
      class="mono"
      style={`color:${emphasis ? "var(--accent)" : "var(--fg-dim)"};font-size:${emphasis ? "var(--fs-lg)" : "var(--fs-md)"};font-weight:var(--fw-bold);line-height:1`}
      aria-hidden="true"
    >
      {sym}
    </span>
  );
}

/**
 * Pain points — three reasons today's stack stops short of "knows
 * me". We compress the deck's three cards into a single tinted card
 * so the help page never feels like a sales page; the focus is on
 * naming the gap MemOS fills, not on selling against alternatives.
 */
function PainPoints({ isZh }: { isZh: boolean }) {
  const pains = [
    {
      icon: "book-open" as IconName,
      title: isZh ? "预训练学不到你的世界" : "Pre-training never saw your world",
      desc: isZh
        ? "互联网上没有你的代码库、你的目录结构、你的业务约束。模型再大，对「你的环境」也是第一次见。"
        : "Your codebase, your directory layout, your business constraints — none of them are on the open web. No matter how big the model is, it meets your environment for the first time every session.",
    },
    {
      icon: "zap" as IconName,
      title: isZh ? "微调成本太高、跟不上变化" : "Fine-tuning is too slow and too expensive",
      desc: isZh
        ? "用本地数据微调一个自有模型？动辄几十小时 GPU、上万元一次。而你的项目每天都在变，根本来不及。"
        : "Fine-tuning a private model on your data costs dozens of GPU-hours per round. Your project changes every day — the loop is too slow to ever catch up.",
    },
    {
      icon: "search" as IconName,
      title: isZh ? "RAG 只能「找回」，不能「学会」" : "RAG only retrieves — it does not learn",
      desc: isZh
        ? "把文档切片塞进向量库，只解决了「能搜到」的问题。用户的反馈、踩过的坑、走过的捷径 —— 沉淀不下来，下次还得从头再来。"
        : "Stuffing chunks into a vector store only solves search. Feedback, mistakes you corrected, shortcuts that worked — none of it sticks. The next task starts from zero.",
    },
  ];
  return (
    <section class="card" style="margin-bottom:var(--sp-5)">
      <h3 class="card__title" style="margin-bottom:var(--sp-1)">
        {isZh ? "为什么需要它 · 当前栈的三个缺口" : "Why it matters · Three gaps in today's stack"}
      </h3>
      <p class="card__subtitle" style="margin-bottom:var(--sp-4);max-width:780px">
        {isZh
          ? "大模型缺的不是「知识」，而是让 Agent 在执行过程中把每一步都学进去的机制。"
          : "What LLMs lack isn't knowledge — it's a mechanism that lets the agent learn from every single step it takes."}
      </p>
      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-3)"
      >
        {pains.map((p) => (
          <div
            key={p.title}
            style="display:flex;gap:var(--sp-3);padding:var(--sp-4);background:var(--bg-canvas);border:1px solid var(--border);border-radius:var(--radius-md);transition:border-color var(--dur-xs);position:relative"
          >
            <span
              style="position:absolute;left:0;top:14px;bottom:14px;width:3px;background:var(--danger);border-radius:0 2px 2px 0"
              aria-hidden="true"
            />
            <span
              style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:var(--danger-soft);color:var(--danger);flex-shrink:0;margin-left:6px"
            >
              <Icon name={p.icon} size={16} />
            </span>
            <div>
              <div style="font-size:var(--fs-md);font-weight:var(--fw-semi);color:var(--fg);margin-bottom:4px;line-height:1.4">
                {p.title}
              </div>
              <div style="font-size:var(--fs-xs);color:var(--fg-muted);line-height:1.65">
                {p.desc}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Learning pipeline — the 5-step processing chain.
 *
 * Each step is one row: a coloured number badge, an inline title,
 * and a short description. The colour gradient from cyan (capture)
 * through amber/violet/green walks the reader through the same L1
 * → L2 → L3 / Skill split that the asset pyramid below uses.
 */
function LearningPipeline({ isZh }: { isZh: boolean }) {
  const steps: {
    n: string;
    color: string;
    bg: string;
    title: string;
    why: string;
    desc: string;
  }[] = [
    {
      n: "1",
      color: LAYER.memory.color,
      bg: LAYER.memory.bg,
      title: isZh ? "步级证据捕获" : "Step-level evidence capture",
      why: isZh ? "原材料 · 颗粒度起点" : "Raw material · the unit of learning",
      desc: isZh
        ? "把整条执行过程切成原子单元 —— 动作 / 观察 / 反思各自独立成行。这是后续所有学习的根基。"
        : "Split each execution into atomic rows — action, observation, reflection — independently recorded. Every later abstraction grounds back to these rows.",
    },
    {
      n: "2",
      color: LAYER.memory.color,
      bg: LAYER.memory.bg,
      title: isZh ? "反思加权回溯" : "Reflection-weighted backflow",
      why: isZh ? "双层反馈 · 任务级回流" : "Dual feedback · task-level routing",
      desc: isZh
        ? "用户一句反馈，沿执行路径反向归因，每一步独立得分 —— 关键步骤拿高分，低效试探自然衰减。"
        : "A single user reaction is back-propagated along the trajectory, scoring every step. Key moments rise, dead-ends fade — without manual labels.",
    },
    {
      n: "3",
      color: LAYER.experience.color,
      bg: LAYER.experience.bg,
      title: isZh ? "跨任务策略归纳" : "Cross-task induction",
      why: isZh ? "L2 经验 · 举一反三" : "L2 experience · transferable strategy",
      desc: isZh
        ? "按「问题特征指纹」实时聚类 —— 多任务出现相似指纹自动触发归纳，提炼为带触发 / 步骤 / 验证 / 边界的可迁移经验。"
        : "Tasks are bucketed live by problem fingerprint. When several different tasks share a pattern, the system distils it into a portable strategy with trigger / procedure / verification / boundary.",
    },
    {
      n: "4a",
      color: LAYER.envKn.color,
      bg: LAYER.envKn.bg,
      title: isZh ? "场域认知抽象" : "Field cognition (L2 → L3)",
      why: isZh ? "L3 · 主题画像" : "L3 · subject profile",
      desc: isZh
        ? "把同主题的 L2 经验聚合为领域全景画像 —— 组成、规律、有效与失败的决策路径。下次同主题任务直接基于已有认知规划。"
        : "L2 experiences on the same subject converge into a domain portrait — components, rules, decisions that worked or failed. Next time the same subject comes up, planning starts from this picture.",
    },
    {
      n: "4b",
      color: LAYER.skill.color,
      bg: LAYER.skill.bg,
      title: isZh ? "高频模式结晶" : "Skill crystallisation (L2 → Skill)",
      why: isZh ? "Skill · 能力固化" : "Skill · solidified ability",
      desc: isZh
        ? "L2 中持续高频成功的模式，凝结为可直接调用的 Skill，自带可靠度 η 与适用边界 —— 用得越多越准。"
        : "Patterns that keep working across many L2 experiences crystallise into invokable Skills, each carrying its own reliability score η and scope. The more they're used, the more accurate they become.",
    },
  ];
  return (
    <section class="card" style="margin-bottom:var(--sp-5)">
      <h3 class="card__title" style="margin-bottom:var(--sp-1)">
        {isZh ? "学习是怎么发生的 · 五步加工链" : "How learning happens · 5-step processing chain"}
      </h3>
      <p class="card__subtitle" style="margin-bottom:var(--sp-4);max-width:780px">
        {isZh
          ? "前三步打底（捕获 → 评分 → 归纳），第四步并列分流出 L3 场域认知 与 Skill 技能。"
          : "Steps 1-3 build the base (capture → score → induce). Step 4 splits in parallel into L3 field cognition and Skills."}
      </p>
      <div style="position:relative;padding-left:18px">
        {/* Vertical connector line behind the numbered badges so the
            5 steps read as a single chain instead of 5 unrelated
            rows. Stops 18px before the bottom so the "4b" badge
            doesn't trail off into nothing. */}
        <span
          style="position:absolute;left:17px;top:18px;bottom:18px;width:2px;background:linear-gradient(to bottom,var(--cyan),var(--amber),var(--green) 70%,var(--violet));opacity:.35;border-radius:1px"
          aria-hidden="true"
        />
        <div class="vstack" style="gap:var(--sp-4)">
          {steps.map((s) => (
            <div
              key={s.n}
              style="display:flex;gap:var(--sp-4);align-items:flex-start;position:relative"
            >
              <span
                style={`position:relative;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;padding:0 8px;border-radius:50%;background:${s.color};color:var(--accent-fg);font-weight:var(--fw-bold);font-size:var(--fs-sm);font-family:var(--font-mono);box-shadow:0 0 0 4px var(--bg-elev-1)`}
              >
                {s.n}
              </span>
              <div style="flex:1;min-width:0">
                <div
                  style="display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--sp-2);margin-bottom:4px"
                >
                  <span style="font-size:var(--fs-md);font-weight:var(--fw-semi);color:var(--fg)">
                    {s.title}
                  </span>
                  <span
                    style={`font-size:var(--fs-2xs);font-weight:var(--fw-semi);color:${s.color};background:${s.bg};padding:2px 8px;border-radius:var(--radius-sm);letter-spacing:.02em`}
                  >
                    {s.why}
                  </span>
                </div>
                <div style="font-size:var(--fs-sm);color:var(--fg-muted);line-height:1.7">
                  {s.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Memory pyramid — the four long-term memory assets the pipeline
 * deposits. Replaces the old "evolution pipeline" strip; that
 * version showed the flow but not what each layer *is*. The card
 * here pairs every layer with its concrete shape (action rows /
 * trigger-procedure / topic profile / invokable skill).
 */
function MemoryAssets({ isZh }: { isZh: boolean }) {
  const layers = [
    {
      tier: "Skill",
      icon: "wand-sparkles" as IconName,
      label: isZh ? "技能" : "Skill",
      tag: isZh ? "可直接调用的能力 · 由 L2 结晶" : "Crystallised capability · from L2",
      desc: isZh
        ? "持续高频成功的策略结晶为带可靠度的 Skill —— 自动浮起优胜者、淘汰失效者，无需人工维护。"
        : "Strategies that keep working solidify into callable Skills with reliability scores. Winners auto-promote, stale ones auto-archive — no maintenance required.",
      ...LAYER.skill,
    },
    {
      tier: "L3",
      icon: "globe" as IconName,
      label: isZh ? "环境认知 / 场域认知" : "Environment / field cognition",
      tag: isZh ? "主题画像 · 由 L2 抽象" : "Subject profile · abstracted from L2",
      desc: isZh
        ? "同主题经验聚合后的全面认知 —— 组成、特点、过往决策的对与错。下次同主题任务直接基于已有认知规划。"
        : "A topic-level portrait built from many L2 experiences — components, traits, decisions that worked or didn't. Next time the same subject comes up, planning starts from here.",
      ...LAYER.envKn,
    },
    {
      tier: "L2",
      icon: "sparkles" as IconName,
      label: isZh ? "跨任务经验" : "Cross-task experience",
      tag: isZh ? "可迁移子问题策略" : "Transferable subtask policy",
      desc: isZh
        ? "从多个不同任务里提炼出的可迁移子问题策略：触发 / 步骤 / 验证 / 边界。"
        : "Reusable subtask strategies distilled from multiple different tasks: trigger / procedure / verification / boundary.",
      ...LAYER.experience,
    },
    {
      tier: "L1",
      icon: "brain-circuit" as IconName,
      label: isZh ? "原始记忆" : "Memory traces",
      tag: isZh ? "步级证据 · 所有上层抽象的根基" : "Step-level evidence · base of every abstraction",
      desc: isZh
        ? "每一步交互的原始记录 —— 动作、观察、反思、价值分。每条结论都可追溯到这里。"
        : "The raw record of every step — action, observation, reflection, value score. Every higher-level conclusion grounds back to one of these rows.",
      ...LAYER.memory,
    },
  ];
  return (
    <section class="card" style="margin-bottom:var(--sp-5)">
      <h3 class="card__title" style="margin-bottom:var(--sp-1)">
        {isZh ? "学习的产出 · 四类长期记忆资产" : "What the system produces · Four long-term memory assets"}
      </h3>
      <p class="card__subtitle" style="margin-bottom:var(--sp-4);max-width:780px">
        {isZh
          ? "L1 是底座、L2 是中层经验；从 L2 之上，L3 场域认知 与 Skill 技能 并列产出，分别对应「领域知识」与「可调用能力」两个维度。"
          : "L1 is the base; L2 sits above it. From L2, L3 field cognition and Skills are produced in parallel — covering the \u201cdomain knowledge\u201d and \u201ccallable capability\u201d dimensions respectively."}
      </p>
      <div class="vstack" style="gap:var(--sp-2)">
        {layers.map((l) => (
          <div
            key={l.tier}
            style={`display:flex;gap:var(--sp-3);align-items:flex-start;padding:var(--sp-4);background:var(--bg-canvas);border:1px solid var(--border);border-left:3px solid ${l.color};border-radius:var(--radius-md);transition:border-color var(--dur-xs)`}
          >
            <span
              style={`display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:10px;background:${l.bg};color:${l.color};flex-shrink:0`}
            >
              <Icon name={l.icon} size={17} />
            </span>
            <div style="flex:1;min-width:0">
              <div
                style="display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--sp-2);margin-bottom:4px"
              >
                <span
                  class="mono"
                  style={`font-size:var(--fs-2xs);font-weight:var(--fw-bold);color:${l.color};background:${l.bg};padding:1px 8px;border-radius:var(--radius-sm);letter-spacing:.08em`}
                >
                  {l.tier}
                </span>
                <span style="font-size:var(--fs-md);font-weight:var(--fw-semi);color:var(--fg)">
                  {l.label}
                </span>
                <span
                  class="muted"
                  style="font-size:var(--fs-2xs);font-weight:var(--fw-med)"
                >
                  · {l.tag}
                </span>
              </div>
              <div style="font-size:var(--fs-sm);color:var(--fg-muted);line-height:1.65">
                {l.desc}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Dual feedback — the two simultaneous learning signals (env + you).
 * Two-column tinted layout matches the deck's visual but uses the
 * panel's cyan/rose tokens so dark-theme users don't see a stray
 * marketing palette.
 */
function DualFeedback({ isZh }: { isZh: boolean }) {
  const lanes = [
    {
      icon: "globe" as IconName,
      side: isZh ? "模型 ↔ 环境" : "Model ↔ Environment",
      title: isZh ? "步级反馈" : "Step-level feedback",
      who: isZh ? "来自执行现场 · 由 Agent 自动产生" : "From the runtime · produced by the agent itself",
      desc: isZh
        ? "每一步动作执行后，环境立刻给出客观结果，Agent 当场写下步级反思 —— 既贴近结果，又保留推理依据，本身就是高质量的反馈内容，无需任何人工标注。"
        : "After every action, the environment returns an objective result and the agent immediately writes a step-level reflection. The reflection is both grounded and reasoned — already a high-quality feedback signal, with no manual labelling required.",
      color: "var(--cyan)",
      bg: "var(--cyan-bg)",
    },
    {
      icon: "users" as IconName,
      side: isZh ? "人类 ↔ 模型" : "Human ↔ Model",
      title: isZh ? "任务级反馈" : "Task-level feedback",
      who: isZh ? "来自用户 · 完成后给出" : "From you · once the task is done",
      desc: isZh
        ? "你说一句「这次不错 / 不对、应该 X」就是最权威的评判信号。系统沿「目标达成 / 过程质量 / 满意度」三轴分解，按反思权重精准回流到每一步。"
        : "A single \u201cnice\u201d or \u201cnope, should be X\u201d is the most authoritative signal. The system splits it along three axes — goal / process / satisfaction — and back-routes the score to every step using reflection weights.",
      color: "var(--rose)",
      bg: "var(--rose-bg)",
    },
  ];
  return (
    <section class="card" style="margin-bottom:var(--sp-5)">
      <h3 class="card__title" style="margin-bottom:var(--sp-1)">
        {isZh ? "学习的能源 · 双层反馈闭环" : "Learning's fuel · Dual feedback loop"}
      </h3>
      <p class="card__subtitle" style="margin-bottom:var(--sp-4);max-width:780px">
        {isZh
          ? "环境给客观对错、你给主观期待；两路反馈相互校准，AI 才能学到既跑得通、又对齐你的能力。"
          : "The environment supplies objective right/wrong; you supply subjective expectations. Calibrating both is what lets the AI learn capabilities that actually run and stay aligned to you."}
      </p>
      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:var(--sp-3)"
      >
        {lanes.map((l) => (
          <div
            key={l.title}
            style={`display:flex;flex-direction:column;gap:var(--sp-2);padding:var(--sp-4);background:var(--bg-canvas);border:1px solid var(--border);border-top:3px solid ${l.color};border-radius:var(--radius-md)`}
          >
            <div class="hstack" style="gap:var(--sp-2)">
              <span
                style={`display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:${l.bg};color:${l.color};flex-shrink:0`}
              >
                <Icon name={l.icon} size={16} />
              </span>
              <div>
                <div
                  class="mono"
                  style={`font-size:var(--fs-2xs);font-weight:var(--fw-bold);color:${l.color};letter-spacing:.08em`}
                >
                  {l.side}
                </div>
                <div style="font-size:var(--fs-md);font-weight:var(--fw-semi);color:var(--fg)">
                  {l.title}
                </div>
              </div>
            </div>
            <div
              class="muted"
              style="font-size:var(--fs-2xs);font-weight:var(--fw-med);padding-left:40px"
            >
              {l.who}
            </div>
            <div style="font-size:var(--fs-sm);color:var(--fg-muted);line-height:1.7;padding-left:40px">
              {l.desc}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Core mechanisms — five engineering decisions that make
 * "execution as learning" actually run. Each card uses the deck's
 * Pain → Method → Benefit triangle, but rendered as three labelled
 * rows so it sits on a single ~140px card height.
 */
function CoreMechanisms({ isZh }: { isZh: boolean }) {
  type Bullet = {
    code: string;
    icon: IconName;
    title: string;
    pain: string;
    method: string;
    benefit: string;
  };
  const items: Bullet[] = [
    {
      code: "01",
      icon: "share-2",
      title: isZh ? "反思加权回溯" : "Reflection-weighted backflow",
      pain: isZh
        ? "整段执行链里哪一步真正贡献结果，传统做法无从分辨。"
        : "Traditional setups can't tell which step in a long trajectory actually mattered.",
      method: isZh
        ? "以反思质量为权重 —— 关键步骤高权、低效试探低权，用户反馈按权重回流到每一步。"
        : "Use reflection quality as weights — key steps weighted high, dead-ends low — and route the user signal back to each step proportionally.",
      benefit: isZh
        ? "长任务里那一两个「想清楚的关键步骤」不再被埋没；下次相似情境，AI 优先复用高分步骤。"
        : "The one or two clear-thinking steps in a long task no longer get buried. Similar situations later prefer the high-scoring steps.",
    },
    {
      code: "02",
      icon: "workflow",
      title: isZh ? "跨任务归纳" : "Cross-task induction",
      pain: isZh
        ? "单任务总结再好，跨任务的共性也看不出来 —— 用户得自己把 A、B 的坑联系起来。"
        : "Per-task summaries don't surface shared patterns — the human has to spot \u201cA's bug and B's bug are the same\u201d themselves.",
      method: isZh
        ? "按「问题特征指纹」实时分桶 —— 多任务出现相似指纹自动归纳为带触发 / 步骤 / 验证 / 边界的经验。"
        : "Bucket every task live by problem fingerprint. When several different tasks share one, distil a strategy with trigger / procedure / verification / boundary.",
      benefit: isZh
        ? "AI 越用越会「想起」过去类似情境，跨任务的能力迁移自然发生。"
        : "The AI starts \u201cremembering\u201d analogous situations on its own — capability transfer between tasks happens by itself.",
    },
    {
      code: "03",
      icon: "globe",
      title: isZh ? "场域认知" : "Field cognition",
      pain: isZh
        ? "同一个主题聊了几十次，AI 仍像初次接触 —— 每次重新介绍背景、重新摸索结构。"
        : "After dozens of conversations on the same subject, the AI still acts like it's the first time — re-introducing context every round.",
      method: isZh
        ? "同主题经验自动聚合为领域全景画像 —— 组成、特点、有效与失败的决策路径。"
        : "Same-subject experiences aggregate into a domain portrait — components, traits, decisions that worked or didn't.",
      benefit: isZh
        ? "下次同主题任务，AI 不再重新摸索 —— 直接基于已有认知规划。"
        : "Next time the same subject comes up, the AI plans straight from the existing portrait instead of re-exploring.",
    },
    {
      code: "04",
      icon: "wand-sparkles",
      title: isZh ? "技能结晶" : "Skill crystallisation",
      pain: isZh
        ? "多数 Skill 是写死的模板 —— 调用一万次也不会变更准，过时也不会自动退役。"
        : "Most skill systems use hand-written templates — they don't get more accurate with use, and don't retire when stale.",
      method: isZh
        ? "每条技能自带可靠度 η，调用结果实时回流。越用越准的自动浮起，渐失效的自动归档。"
        : "Each skill carries a reliability score η that updates with every invocation. Improving skills auto-promote; degrading ones auto-archive.",
      benefit: isZh
        ? "技能库永不变脏 —— 好用的反复推荐，无效的自动消失，全程零维护。"
        : "The skill library stays clean by itself — useful skills surface, broken ones disappear, with zero manual upkeep.",
    },
    {
      code: "05",
      icon: "shield",
      title: isZh ? "决策修复" : "Decision repair",
      pain: isZh
        ? "你纠正一次 AI 改对一次，下次又重蹈覆辙 —— 普通 memory 记不住「X 场景下避免 Y」的情境化偏好。"
        : "You correct it, it agrees, then it makes the exact same mistake next time. Plain memory can't capture \u201cin context X, avoid Y\u201d.",
      method: isZh
        ? "同工具连续失败、或用户说「不对、应该 X」时，系统对比成败步骤，自动生成「该做什么 / 避免什么」的避坑规则，绑定到对应资产。"
        : "On repeated tool failures or a user \u201cshould be X\u201d, the system contrasts the success / failure traces and writes a prefer / avoid rule, attached to the relevant asset.",
      benefit: isZh
        ? "同样的坑，AI 不会再踩第二次 —— 情境化教训真正变成系统能力。"
        : "The same pitfall doesn't get hit twice — situated lessons actually become system-level capability.",
    },
  ];
  return (
    <section class="card" style="margin-bottom:var(--sp-5)">
      <h3 class="card__title" style="margin-bottom:var(--sp-1)">
        {isZh ? "5 项让它真正落地的核心机制" : "Five mechanisms that make it actually run"}
      </h3>
      <p class="card__subtitle" style="margin-bottom:var(--sp-4);max-width:780px">
        {isZh
          ? "每条都用「痛点 → 我们怎么做 → 你会感受到」三段呈现 —— 把工程决策翻译成你能感知的体验差异。"
          : "Each is rendered as Problem → Method → Benefit — engineering decisions translated into the experience differences you'll actually notice."}
      </p>
      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:var(--sp-3)"
      >
        {items.map((m) => (
          <div
            key={m.code}
            style="border:1px solid var(--border);border-radius:var(--radius-md);padding:var(--sp-4);background:var(--bg-canvas);display:flex;flex-direction:column;gap:var(--sp-3)"
          >
            <div
              style="display:flex;gap:var(--sp-3);align-items:flex-start;padding-bottom:var(--sp-2);border-bottom:1px solid var(--border)"
            >
              <span
                style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:var(--accent-soft);color:var(--accent);flex-shrink:0"
              >
                <Icon name={m.icon} size={15} />
              </span>
              <div style="flex:1;min-width:0">
                <div
                  class="mono"
                  style="font-size:var(--fs-2xs);font-weight:var(--fw-bold);color:var(--accent);letter-spacing:.1em;margin-bottom:2px"
                >
                  CORE · {m.code}
                </div>
                <div
                  style="font-size:var(--fs-md);font-weight:var(--fw-semi);color:var(--fg);line-height:1.35"
                >
                  {m.title}
                </div>
              </div>
            </div>
            <MechRow
              label={isZh ? "痛点" : "Problem"}
              text={m.pain}
              tone="danger"
            />
            <MechRow
              label={isZh ? "怎么做" : "Method"}
              text={m.method}
              tone="info"
            />
            <MechRow
              label={isZh ? "你会感受到" : "Benefit"}
              text={m.benefit}
              tone="success"
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function MechRow({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: "danger" | "info" | "success";
}) {
  const palette = {
    danger: { color: "var(--danger)", bg: "var(--danger-soft)" },
    info: { color: "var(--info)", bg: "var(--info-soft)" },
    success: { color: "var(--success)", bg: "var(--success-soft)" },
  }[tone];
  return (
    <div
      style="display:grid;grid-template-columns:auto 1fr;gap:6px var(--sp-2);align-items:start"
    >
      <span
        style={`grid-row:1 / span 2;align-self:flex-start;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:${palette.bg};color:${palette.color};margin-top:3px`}
      >
        <span
          style={`width:6px;height:6px;border-radius:50%;background:${palette.color}`}
        />
      </span>
      <span
        class="mono"
        style={`font-size:var(--fs-2xs);font-weight:var(--fw-bold);color:${palette.color};letter-spacing:.06em;line-height:1.4`}
      >
        {label}
      </span>
      <span style="font-size:var(--fs-sm);color:var(--fg-muted);line-height:1.65">
        {text}
      </span>
    </div>
  );
}

/**
 * Three-tier retrieval — what comes BACK out of the system at the
 * start of a new task. Replaces the original "How the system reuses
 * knowledge" card; this version names the trigger conditions
 * (1: any new task / 2: edge case / 3: matched subject) so users
 * understand the priority ordering, not just the contents.
 */
function ThreeTierRetrieval({ isZh }: { isZh: boolean }) {
  const tiers = [
    {
      n: "1",
      role: isZh ? "任务入口" : "Task entry",
      icon: "wand-sparkles" as IconName,
      title: isZh ? "Skill 召回 · 给骨架" : "Skill recall · the skeleton",
      desc: isZh
        ? "新任务进来先匹配 Skill —— 命中就直接注入步骤 / 边界 / 避坑规则，给 AI 一套成熟方案，一步到位。"
        : "Every new task starts here. If a Skill matches, its procedure / scope / repair rules are injected as a ready-made solution.",
      color: LAYER.skill.color,
      bg: LAYER.skill.bg,
    },
    {
      n: "2",
      role: isZh ? "执行受阻" : "Execution stalls",
      icon: "brain-circuit" as IconName,
      title: isZh ? "记忆召回 · 补细节" : "Memory recall · the details",
      desc: isZh
        ? "没匹配到 Skill 或遇到边界场景时，按价值分召回最相关的历史执行步骤，给 AI 一份「上次类似情境是怎么解决的」参考。"
        : "When no Skill matches or the situation is an edge case, the most relevant past steps are surfaced by value score — a reference for \u201chow was this kind of thing solved last time?\u201d",
      color: LAYER.memory.color,
      bg: LAYER.memory.bg,
    },
    {
      n: "3",
      role: isZh ? "同主题任务" : "Subject match",
      icon: "globe" as IconName,
      title: isZh ? "环境认知召回 · 给背景" : "Environment recall · the backdrop",
      desc: isZh
        ? "命中已积累的主题画像时，直接调出领域全景 —— 组成、特点、有效与失败的决策，让 AI 跳过零探索的规划。"
        : "When the task's subject already has a profile, the full domain portrait is pulled in — components, traits, prior decisions — so planning skips the discovery phase.",
      color: LAYER.envKn.color,
      bg: LAYER.envKn.bg,
    },
  ];
  return (
    <section class="card" style="margin-bottom:var(--sp-5)">
      <h3 class="card__title" style="margin-bottom:var(--sp-1)">
        {isZh ? "学到的怎么用 · 三层按需检索" : "How learning is used · 3-tier on-demand retrieval"}
      </h3>
      <p class="card__subtitle" style="margin-bottom:var(--sp-4);max-width:780px">
        {isZh
          ? "上下文窗口很贵 —— 不是每次都灌一堆，而是按 Agent 当前阶段动态切换检索粒度。要行动取 Skill，要参考取记忆，要做主题规划取场域认知。"
          : "Context windows are expensive. Instead of shoving everything in, the granularity changes with the agent's current phase: Skill for action, memory for reference, field cognition for subject-level planning."}
      </p>
      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--sp-3)"
      >
        {tiers.map((t) => (
          <div
            key={t.n}
            style={`background:var(--bg-canvas);border:1px solid var(--border);border-top:3px solid ${t.color};border-radius:var(--radius-md);padding:var(--sp-4);display:flex;flex-direction:column;gap:var(--sp-2)`}
          >
            <div class="hstack" style="gap:var(--sp-2);align-items:center">
              <span
                class="mono"
                style={`display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${t.color};color:var(--accent-fg);font-weight:var(--fw-bold);font-size:var(--fs-sm)`}
              >
                {t.n}
              </span>
              <span
                style={`display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:${t.bg};color:${t.color}`}
              >
                <Icon name={t.icon} size={12} />
              </span>
              <span
                class="mono"
                style={`margin-left:auto;font-size:var(--fs-2xs);font-weight:var(--fw-bold);color:${t.color};background:${t.bg};padding:2px 8px;border-radius:var(--radius-sm);letter-spacing:.04em`}
              >
                {t.role}
              </span>
            </div>
            <span
              style={`font-size:var(--fs-md);font-weight:var(--fw-bold);color:var(--fg);line-height:1.35`}
            >
              {t.title}
            </span>
            <span style="font-size:var(--fs-xs);color:var(--fg-muted);line-height:1.65">
              {t.desc}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Architecture diagram
 *
 * This is a near-verbatim port of the SVG used on the launch-2.0
 * landing page (Memory-Skill Co-Evolution). The user explicitly
 * asked for visual parity with that deck, so the SVG keeps its
 * original 752 × 660 viewBox, hand-tuned coordinates, and its
 * light-themed hex palette (#ec4899 / #06b6d4 / #a78bfa / …) — the
 * diagram is meant to read as a single illustrated artefact, not
 * as recomposed dashboard tokens.
 *
 * Wrapper notes:
 *   - The `.card` shell uses the same surface as neighbouring help
 *     sections (`var(--bg-elev-1)`) so the diagram blends with the
 *     panel instead of looking like a foreign light-theme island.
 *   - Every fill / stroke / text colour inside the SVG resolves
 *     through theme tokens (`var(--rose)`, `var(--cyan)`,
 *     `var(--violet)`, `var(--bg-canvas)`, `var(--fg)`, …) so the
 *     diagram automatically inverts for dark mode while keeping
 *     the same geometry as launch-2.0. The gradient circles
 *     (L1/L2/L3/Skill) still render with vivid hex stops because
 *     they are intentionally branded "saturated" shapes that read
 *     well on both backdrops.
 *   - `viewBox` keeps the diagram crisp at any width; the cap is
 *     bumped to ~1000px so it can breathe on wider viewports.
 *   - i18n only swaps the labels; the geometry never changes.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Architecture diagram — direct port of the launch-2.0 SVG.
 *
 * Visual structure (top → bottom):
 *
 *   01  EXECUTION LAYER  · 在做事
 *       └─ User ↔ Agent execution loop ↔ Environment
 *   02  LEARNING LAYER   · 在学习
 *       └─ Capture → Score → Induce → (Abstract / Crystallise)
 *   03  ASSET LAYER      · 在沉淀
 *       └─ L1 / L2 / L3 / Skill cards
 *   ↻   Right-side return channel feeds assets back into Agent
 *       (the "next-task injection" loop).
 *
 * Coordinates match the launch-2.0 source 1-to-1 (same 752×660
 * viewBox, same path data) so any future visual change in the deck
 * can transfer over with simple coord copies. Colour values are
 * intentionally NOT 1-to-1: they were lifted to dashboard tokens
 * (`var(--rose)`, `var(--violet)`, `var(--bg-elev-1)`, …) so the
 * diagram inherits the panel's palette and theme inversion.
 */
function ArchitectureDiagram({ isZh }: { isZh: boolean }) {
  return (
    <section
      class="card"
      style="margin-bottom:var(--sp-5);padding:var(--sp-6) var(--sp-3) var(--sp-5)"
    >
      <div
        class="mono"
        style="text-align:center;font-size:var(--fs-md);font-weight:var(--fw-bold);color:var(--violet);letter-spacing:.22em;margin-bottom:10px"
      >
        MEMORY-SKILL CO-EVOLUTION
      </div>
      <div
        style="text-align:center;font-size:var(--fs-xl);font-weight:var(--fw-bold);color:var(--fg);margin-bottom:var(--sp-8);letter-spacing:-.01em;line-height:1.3"
      >
        {isZh
          ? "让 Agent 在执行中学习的完整架构"
          : "How the agent learns while executing"}
      </div>

      <svg
        viewBox="0 0 752 660"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Memory-Skill Co-Evolution Architecture"
        style="display:block;margin:0 auto;width:100%;max-width:1000px;height:auto"
      >
          <defs>
            {/* L1 / L2 / L3 / Skill gradient circles & verticals are
                kept saturated on purpose — they are branded "asset"
                shapes that need to read as vivid identifiers in
                both themes. The User/Agent/Env panel washes were
                converted to theme-token fills (var(--rose-bg) /
                var(--accent-soft) / var(--cyan-bg)), so those
                gradient defs were removed. */}
            <linearGradient id="adgL1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#06b6d4" />
              <stop offset="1" stop-color="#0891b2" />
            </linearGradient>
            <linearGradient id="adgL2" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#818cf8" />
              <stop offset="1" stop-color="#6366f1" />
            </linearGradient>
            <linearGradient id="adgL3" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#a78bfa" />
              <stop offset="1" stop-color="#7c3aed" />
            </linearGradient>
            <linearGradient id="adgSkill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#ec4899" />
              <stop offset="1" stop-color="#db2777" />
            </linearGradient>
            <marker
              id="adArrow"
              markerWidth="7"
              markerHeight="6"
              refX="6.5"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0,7 3,0 6" fill="var(--violet)" />
            </marker>
            <marker
              id="adArrowPink"
              markerWidth="7"
              markerHeight="6"
              refX="6.5"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0,7 3,0 6" fill="var(--rose)" />
            </marker>
            <marker
              id="adArrowCyan"
              markerWidth="7"
              markerHeight="6"
              refX="6.5"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0,7 3,0 6" fill="var(--cyan)" />
            </marker>
            <filter id="adShadow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" in="SourceAlpha" />
              <feOffset dx="0" dy="2" />
              <feComponentTransfer>
                <feFuncA type="linear" slope=".15" />
              </feComponentTransfer>
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* ── 01 EXECUTION LAYER ─────────────────────────────── */}
          <text
            x="340"
            y="22"
            text-anchor="middle"
            font-size="12"
            font-weight="800"
            fill="var(--violet)"
            letter-spacing="3"
            font-family="system-ui"
          >
            {isZh ? "EXECUTION LAYER · 在做事" : "EXECUTION LAYER · running"}
          </text>

          {/* User box */}
          <rect
            x="20"
            y="42"
            width="120"
            height="100"
            rx="14"
            fill="var(--rose-bg)"
            stroke="var(--rose)"
            stroke-width="2.5"
            filter="url(#adShadow)"
          />
          <rect
            x="20"
            y="42"
            width="120"
            height="100"
            rx="14"
            fill="none"
            stroke="color-mix(in srgb,var(--rose) 25%,transparent)"
            stroke-width="6"
          />
          <text
            x="80"
            y="76"
            text-anchor="middle"
            font-size="28"
            font-family="system-ui"
          >
            👤
          </text>
          <text
            x="80"
            y="105"
            text-anchor="middle"
            font-size="14"
            font-weight="900"
            fill="var(--rose)"
            font-family="system-ui"
          >
            {isZh ? "用户反馈" : "You"}
          </text>
          <text
            x="80"
            y="125"
            text-anchor="middle"
            font-size="10.5"
            font-weight="700"
            fill="var(--rose)"
            font-family="system-ui"
          >
            {isZh ? "主观期待 · 偏好 · 纠正" : "Goals · prefs · fixes"}
          </text>

          {/* Agent loop card */}
          <text
            x="340"
            y="38"
            text-anchor="middle"
            font-size="12"
            font-weight="900"
            fill="var(--fg)"
            font-family="system-ui"
          >
            {isZh ? "🤖 Agent 执行循环" : "🤖 Agent execution loop"}
          </text>
          <rect
            x="160"
            y="46"
            width="364"
            height="100"
            rx="16"
            fill="var(--accent-soft)"
            stroke="color-mix(in srgb,var(--accent) 45%,transparent)"
            stroke-width="1.5"
            filter="url(#adShadow)"
          />

          {/* Top row: query · 指令 */}
          <g font-size="11" font-weight="600" font-family="system-ui">
            <rect
              x="184"
              y="56"
              width="50"
              height="26"
              rx="13"
              fill="var(--bg-elev-1)"
              stroke="color-mix(in srgb,var(--accent) 35%,transparent)"
            />
            <text x="209" y="73" text-anchor="middle" fill="var(--accent)">
              query
            </text>
            <rect
              x="374"
              y="56"
              width="52"
              height="26"
              rx="13"
              fill="var(--bg-elev-1)"
              stroke="color-mix(in srgb,var(--accent) 35%,transparent)"
            />
            <text x="400" y="73" text-anchor="middle" fill="var(--accent)">
              {isZh ? "指令" : "act"}
            </text>
          </g>

          {/* Bottom row: context · plan · 反思 · 结果 */}
          <g font-size="11" font-weight="600" font-family="system-ui">
            <rect
              x="178"
              y="110"
              width="62"
              height="26"
              rx="13"
              fill="var(--bg-elev-1)"
              stroke="color-mix(in srgb,var(--accent) 35%,transparent)"
            />
            <text x="209" y="127" text-anchor="middle" fill="var(--accent)">
              context
            </text>
            <rect
              x="264"
              y="110"
              width="50"
              height="26"
              rx="13"
              fill="var(--bg-elev-1)"
              stroke="color-mix(in srgb,var(--accent) 35%,transparent)"
            />
            <text x="289" y="127" text-anchor="middle" fill="var(--accent)">
              plan
            </text>
            <rect
              x="338"
              y="106"
              width="80"
              height="34"
              rx="17"
              fill="var(--danger-soft)"
              stroke="color-mix(in srgb,var(--danger) 25%,transparent)"
              stroke-width="5"
            />
            <rect
              x="338"
              y="106"
              width="80"
              height="34"
              rx="17"
              fill="var(--danger-soft)"
              stroke="var(--danger)"
              stroke-width="2"
            />
            <text
              x="378"
              y="128"
              text-anchor="middle"
              font-size="13"
              font-weight="900"
              fill="var(--danger)"
            >
              {isZh ? "⭐ 反思" : "⭐ reflect"}
            </text>
            <rect
              x="438"
              y="110"
              width="54"
              height="26"
              rx="13"
              fill="var(--cyan-bg)"
              stroke="var(--cyan)"
              stroke-width="1.3"
            />
            <text x="465" y="127" text-anchor="middle" fill="var(--cyan)">
              {isZh ? "结果" : "result"}
            </text>
          </g>

          {/* Internal arrows */}
          <line
            x1="209"
            y1="82"
            x2="209"
            y2="110"
            stroke="var(--violet)"
            stroke-width="1.4"
            opacity=".85"
            marker-end="url(#adArrow)"
          />
          <path
            d="M 289 110 V 69 H 372"
            fill="none"
            stroke="var(--violet)"
            stroke-width="1.4"
            opacity=".85"
            marker-end="url(#adArrow)"
          />
          <line
            x1="426"
            y1="69"
            x2="538"
            y2="69"
            stroke="var(--cyan)"
            stroke-width="1.6"
            opacity=".9"
            marker-end="url(#adArrowCyan)"
          />
          <line
            x1="540"
            y1="123"
            x2="492"
            y2="123"
            stroke="var(--cyan)"
            stroke-width="1.6"
            opacity=".9"
            marker-end="url(#adArrowCyan)"
          />
          <line
            x1="240"
            y1="123"
            x2="264"
            y2="123"
            stroke="var(--violet)"
            stroke-width="1.4"
            opacity=".85"
            marker-end="url(#adArrow)"
          />
          <line
            x1="438"
            y1="123"
            x2="418"
            y2="123"
            stroke="var(--violet)"
            stroke-width="1.4"
            opacity=".85"
            marker-end="url(#adArrow)"
          />
          <line
            x1="378"
            y1="106"
            x2="400"
            y2="82"
            stroke="var(--violet)"
            stroke-width="1.4"
            stroke-dasharray="3 3"
            opacity=".85"
            marker-end="url(#adArrow)"
          />
          <text
            x="350"
            y="96"
            text-anchor="middle"
            font-size="9"
            font-weight="700"
            fill="var(--violet)"
            font-family="system-ui"
          >
            {isZh ? "↺ 未完成继续" : "↺ loop until done"}
          </text>
          <circle
            cx="465"
            cy="92"
            r="12"
            fill="none"
            stroke="var(--violet)"
            stroke-width="1.6"
            opacity=".85"
          />
          <text
            x="465"
            y="97"
            text-anchor="middle"
            font-size="15"
            font-weight="900"
            fill="var(--violet)"
            font-family="system-ui"
          >
            ↻
          </text>

          {/* Environment box */}
          <rect
            x="540"
            y="42"
            width="120"
            height="100"
            rx="14"
            fill="var(--cyan-bg)"
            stroke="color-mix(in srgb,var(--cyan) 40%,transparent)"
            stroke-width="1.5"
            filter="url(#adShadow)"
          />
          <text
            x="600"
            y="76"
            text-anchor="middle"
            font-size="28"
            font-family="system-ui"
          >
            🌍
          </text>
          <text
            x="600"
            y="105"
            text-anchor="middle"
            font-size="14"
            font-weight="800"
            fill="var(--cyan)"
            font-family="system-ui"
          >
            {isZh ? "你的环境" : "Your env"}
          </text>
          <text
            x="600"
            y="125"
            text-anchor="middle"
            font-size="10.5"
            fill="var(--cyan)"
            font-family="system-ui"
          >
            {isZh ? "代码 · 工具 · 数据" : "Code · tools · data"}
          </text>

          {/* User ↔ Agent bidirectional */}
          <line
            x1="140"
            y1="84"
            x2="163"
            y2="84"
            stroke="var(--rose)"
            stroke-width="1.8"
            marker-end="url(#adArrowPink)"
          />
          <line
            x1="165"
            y1="100"
            x2="142"
            y2="100"
            stroke="var(--rose)"
            stroke-width="1.8"
            stroke-dasharray="4 3"
            opacity=".7"
            marker-end="url(#adArrowPink)"
          />

          {/* Dual-feedback callouts */}
          <rect
            x="112"
            y="166"
            width="96"
            height="36"
            rx="8"
            fill="var(--rose-bg)"
            stroke="var(--rose)"
            stroke-width="1.5"
          />
          <text
            x="160"
            y="182"
            text-anchor="middle"
            font-size="11"
            font-weight="800"
            fill="var(--rose)"
            font-family="system-ui"
          >
            {isZh ? "人类 ↔ 模型" : "Human ↔ Model"}
          </text>
          <text
            x="160"
            y="196"
            text-anchor="middle"
            font-size="9.5"
            font-weight="700"
            fill="var(--rose)"
            font-family="system-ui"
          >
            {isZh ? "任务级反馈" : "Task-level"}
          </text>
          <rect
            x="472"
            y="166"
            width="96"
            height="36"
            rx="8"
            fill="var(--cyan-bg)"
            stroke="var(--cyan)"
            stroke-width="1.5"
          />
          <text
            x="520"
            y="182"
            text-anchor="middle"
            font-size="11"
            font-weight="800"
            fill="var(--cyan)"
            font-family="system-ui"
          >
            {isZh ? "模型 ↔ 环境" : "Model ↔ Env"}
          </text>
          <text
            x="520"
            y="196"
            text-anchor="middle"
            font-size="9.5"
            font-weight="700"
            fill="var(--cyan)"
            font-family="system-ui"
          >
            {isZh ? "步级反馈" : "Step-level"}
          </text>

          {/* Center bridge: "双层反馈学习闭环" */}
          <rect
            x="252"
            y="170"
            width="176"
            height="28"
            rx="14"
            fill="var(--bg-elev-1)"
            stroke="var(--violet)"
            stroke-width="1.5"
            filter="url(#adShadow)"
          />
          <text
            x="340"
            y="188"
            text-anchor="middle"
            font-size="11"
            font-weight="900"
            fill="var(--violet)"
            font-family="system-ui"
          >
            {isZh ? "⚡ 双层反馈学习闭环" : "⚡ Dual-feedback loop"}
          </text>
          <line
            x1="340"
            y1="200"
            x2="340"
            y2="232"
            stroke="var(--violet)"
            stroke-width="1.8"
            marker-end="url(#adArrow)"
          />

          {/* ── 02 LEARNING LAYER ──────────────────────────────── */}
          <text
            x="340"
            y="252"
            text-anchor="middle"
            font-size="12"
            font-weight="800"
            fill="var(--violet)"
            letter-spacing="3"
            font-family="system-ui"
          >
            {isZh ? "LEARNING LAYER · 在学习" : "LEARNING LAYER · learning"}
          </text>

          <rect
            x="20"
            y="270"
            width="640"
            height="148"
            rx="16"
            fill="var(--bg-canvas)"
            stroke="color-mix(in srgb,var(--violet) 35%,transparent)"
            stroke-width="1.5"
            filter="url(#adShadow)"
          />
          <text
            x="40"
            y="298"
            font-size="13"
            font-weight="800"
            fill="var(--violet)"
            font-family="system-ui"
          >
            {isZh ? "📦 学习加工流水线" : "📦 Processing pipeline"}
          </text>
          <text
            x="640"
            y="298"
            text-anchor="end"
            font-size="11"
            font-weight="600"
            fill="var(--fg-dim)"
            font-family="system-ui"
          >
            {isZh ? "把每一步都\u201c学进去\u201d" : "Learn from every step"}
          </text>

          <g font-family="system-ui">
            <circle cx="92" cy="350" r="26" fill="url(#adgL1)" filter="url(#adShadow)" />
            <text
              x="92"
              y="356"
              text-anchor="middle"
              font-size="13"
              font-weight="900"
              fill="var(--bg-elev-1)"
            >
              {isZh ? "捕获" : "capture"}
            </text>
            <text
              x="92"
              y="386"
              text-anchor="middle"
              font-size="10.5"
              fill="var(--fg-muted)"
            >
              {isZh ? "每步证据" : "per-step evidence"}
            </text>
            <text x="135" y="354" font-size="14" fill="var(--violet)" font-weight="800">
              →
            </text>
            <circle cx="194" cy="350" r="26" fill="url(#adgL2)" filter="url(#adShadow)" />
            <text
              x="194"
              y="356"
              text-anchor="middle"
              font-size="13"
              font-weight="900"
              fill="var(--bg-elev-1)"
            >
              {isZh ? "评分" : "score"}
            </text>
            <text
              x="194"
              y="386"
              text-anchor="middle"
              font-size="10.5"
              fill="var(--fg-muted)"
            >
              {isZh ? "关键 vs 低效" : "key vs noise"}
            </text>
            <text x="237" y="354" font-size="14" fill="var(--violet)" font-weight="800">
              →
            </text>
            <circle cx="296" cy="350" r="26" fill="url(#adgL2)" filter="url(#adShadow)" />
            <text
              x="296"
              y="356"
              text-anchor="middle"
              font-size="13"
              font-weight="900"
              fill="var(--bg-elev-1)"
            >
              {isZh ? "归纳" : "induce"}
            </text>
            <text
              x="296"
              y="386"
              text-anchor="middle"
              font-size="10.5"
              fill="var(--fg-muted)"
            >
              {isZh ? "跨任务策略" : "cross-task"}
            </text>
            <path
              d="M 322 340 Q 350 326 392 322"
              fill="none"
              stroke="var(--violet)"
              stroke-width="1.4"
              opacity=".85"
              marker-end="url(#adArrow)"
            />
            <path
              d="M 322 360 Q 350 374 392 378"
              fill="none"
              stroke="var(--violet)"
              stroke-width="1.4"
              opacity=".85"
              marker-end="url(#adArrow)"
            />
            <circle cx="416" cy="322" r="20" fill="url(#adgL3)" filter="url(#adShadow)" />
            <text
              x="416"
              y="327"
              text-anchor="middle"
              font-size="11"
              font-weight="900"
              fill="var(--bg-elev-1)"
            >
              {isZh ? "抽象" : "abstract"}
            </text>
            <text
              x="446"
              y="318"
              font-size="10"
              font-weight="700"
              fill="var(--violet)"
            >
              {isZh ? "→ L3 场域认知" : "→ L3 cognition"}
            </text>
            <circle cx="416" cy="378" r="20" fill="url(#adgSkill)" filter="url(#adShadow)" />
            <text
              x="416"
              y="383"
              text-anchor="middle"
              font-size="11"
              font-weight="900"
              fill="var(--bg-elev-1)"
            >
              {isZh ? "结晶" : "crystal"}
            </text>
            <text
              x="446"
              y="383"
              font-size="10"
              font-weight="700"
              fill="var(--rose)"
            >
              {isZh ? "→ Skill 技能" : "→ Skill"}
            </text>
            <path
              d="M 540 322 H 558"
              fill="none"
              stroke="var(--violet)"
              stroke-width="1.4"
              opacity=".75"
            />
            <path
              d="M 540 378 H 558"
              fill="none"
              stroke="var(--violet)"
              stroke-width="1.4"
              opacity=".75"
            />
            <path
              d="M 446 332 Q 500 348 558 348"
              fill="none"
              stroke="color-mix(in srgb,var(--violet) 45%,transparent)"
              stroke-width="1.2"
            />
            <path
              d="M 446 368 Q 500 352 558 352"
              fill="none"
              stroke="color-mix(in srgb,var(--violet) 45%,transparent)"
              stroke-width="1.2"
            />
          </g>

          {/* "沉淀为长期能力" chip */}
          <rect
            x="558"
            y="322"
            width="92"
            height="56"
            rx="12"
            fill="var(--rose-bg)"
            stroke="color-mix(in srgb,var(--rose) 40%,transparent)"
            stroke-width="1.5"
          />
          <text
            x="604"
            y="346"
            text-anchor="middle"
            font-size="12.5"
            font-weight="800"
            fill="var(--rose)"
            font-family="system-ui"
          >
            {isZh ? "沉淀为" : "settles into"}
          </text>
          <text
            x="604"
            y="365"
            text-anchor="middle"
            font-size="12.5"
            font-weight="800"
            fill="var(--rose)"
            font-family="system-ui"
          >
            {isZh ? "长期能力" : "long-term"}
          </text>

          <line
            x1="340"
            y1="430"
            x2="340"
            y2="478"
            stroke="var(--violet)"
            stroke-width="1.8"
            marker-end="url(#adArrow)"
          />
          <rect
            x="230"
            y="438"
            width="220"
            height="22"
            rx="11"
            fill="var(--bg-elev-1)"
            stroke="color-mix(in srgb,var(--violet) 35%,transparent)"
          />
          <text
            x="340"
            y="453"
            text-anchor="middle"
            font-size="11"
            font-weight="800"
            fill="var(--violet)"
            font-family="system-ui"
          >
            {isZh ? "沉淀为四类长期记忆资产" : "Deposit as 4 memory assets"}
          </text>

          {/* ── 03 ASSET LAYER ─────────────────────────────────── */}
          <text
            x="340"
            y="500"
            text-anchor="middle"
            font-size="12"
            font-weight="800"
            fill="var(--violet)"
            letter-spacing="3"
            font-family="system-ui"
          >
            {isZh ? "ASSET LAYER · 在沉淀" : "ASSET LAYER · deposited"}
          </text>

          {/* L1 */}
          <rect
            x="20"
            y="518"
            width="150"
            height="92"
            rx="14"
            fill="var(--bg-elev-1)"
            stroke="color-mix(in srgb,var(--cyan) 40%,transparent)"
            stroke-width="1.5"
            filter="url(#adShadow)"
          />
          <rect x="28" y="532" width="5" height="64" rx="2.5" fill="url(#adgL1)" />
          <text
            x="40"
            y="546"
            font-size="15"
            font-weight="900"
            fill="var(--cyan)"
            font-family="system-ui"
          >
            📝 L1
          </text>
          <text
            x="84"
            y="546"
            font-size="11"
            font-weight="700"
            fill="var(--fg-muted)"
            font-family="system-ui"
          >
            {isZh ? "原始记忆" : "Memory"}
          </text>
          <text
            x="40"
            y="572"
            font-size="13"
            font-weight="700"
            fill="var(--fg)"
            font-family="system-ui"
          >
            {isZh ? "每步证据" : "Per-step evidence"}
          </text>
          <text
            x="40"
            y="594"
            font-size="10.5"
            fill="var(--fg-muted)"
            font-family="system-ui"
          >
            {isZh ? "动作·观察·反思" : "Act · obs · reflect"}
          </text>

          {/* L2 */}
          <rect
            x="180"
            y="518"
            width="150"
            height="92"
            rx="14"
            fill="var(--bg-elev-1)"
            stroke="color-mix(in srgb,var(--accent) 40%,transparent)"
            stroke-width="1.5"
            filter="url(#adShadow)"
          />
          <rect x="188" y="532" width="5" height="64" rx="2.5" fill="url(#adgL2)" />
          <text
            x="200"
            y="546"
            font-size="15"
            font-weight="900"
            fill="var(--accent)"
            font-family="system-ui"
          >
            🧬 L2
          </text>
          <text
            x="244"
            y="546"
            font-size="11"
            font-weight="700"
            fill="var(--fg-muted)"
            font-family="system-ui"
          >
            {isZh ? "操作手册" : "Playbook"}
          </text>
          <text
            x="200"
            y="572"
            font-size="13"
            font-weight="700"
            fill="var(--fg)"
            font-family="system-ui"
          >
            {isZh ? "跨任务经验" : "Cross-task exp."}
          </text>
          <text
            x="200"
            y="594"
            font-size="10.5"
            fill="var(--fg-muted)"
            font-family="system-ui"
          >
            {isZh ? "可迁移策略" : "Transferable"}
          </text>

          {/* L3 */}
          <rect
            x="340"
            y="518"
            width="150"
            height="92"
            rx="14"
            fill="var(--bg-elev-1)"
            stroke="color-mix(in srgb,var(--violet) 40%,transparent)"
            stroke-width="1.5"
            filter="url(#adShadow)"
          />
          <rect x="348" y="532" width="5" height="64" rx="2.5" fill="url(#adgL3)" />
          <text
            x="360"
            y="546"
            font-size="15"
            font-weight="900"
            fill="var(--violet)"
            font-family="system-ui"
          >
            🌐 L3
          </text>
          <text
            x="404"
            y="546"
            font-size="11"
            font-weight="700"
            fill="var(--fg-muted)"
            font-family="system-ui"
          >
            {isZh ? "主题认知" : "Cognition"}
          </text>
          <text
            x="360"
            y="572"
            font-size="13"
            font-weight="700"
            fill="var(--fg)"
            font-family="system-ui"
          >
            {isZh ? "场域认知" : "Field cognition"}
          </text>
          <text
            x="360"
            y="594"
            font-size="10.5"
            fill="var(--fg-muted)"
            font-family="system-ui"
          >
            {isZh ? "组成·特点·偏好" : "Parts · traits · prefs"}
          </text>

          {/* Skill */}
          <rect
            x="500"
            y="518"
            width="160"
            height="92"
            rx="14"
            fill="var(--bg-elev-1)"
            stroke="color-mix(in srgb,var(--rose) 40%,transparent)"
            stroke-width="1.5"
            filter="url(#adShadow)"
          />
          <rect x="508" y="532" width="5" height="64" rx="2.5" fill="url(#adgSkill)" />
          <text
            x="520"
            y="546"
            font-size="15"
            font-weight="900"
            fill="var(--rose)"
            font-family="system-ui"
          >
            💎 Skill
          </text>
          <text
            x="578"
            y="546"
            font-size="11"
            font-weight="700"
            fill="var(--fg-muted)"
            font-family="system-ui"
          >
            {isZh ? "能力" : "Capability"}
          </text>
          <text
            x="520"
            y="572"
            font-size="13"
            font-weight="700"
            fill="var(--fg)"
            font-family="system-ui"
          >
            {isZh ? "可调用结晶" : "Invokable"}
          </text>
          <text
            x="520"
            y="594"
            font-size="10.5"
            fill="var(--fg-muted)"
            font-family="system-ui"
          >
            {isZh ? "高频成功模式" : "Proven patterns"}
          </text>

          {/* ── Right-side return channel — assets feed back into Agent loop ── */}
          <rect
            x="672"
            y="4"
            width="60"
            height="610"
            rx="10"
            fill="var(--rose-bg)"
            stroke="color-mix(in srgb,var(--rose) 25%,transparent)"
            stroke-dasharray="4 3"
          />
          <line
            x1="95"
            y1="518"
            x2="95"
            y2="508"
            stroke="var(--cyan)"
            stroke-width="1.4"
            opacity=".7"
          />
          <line
            x1="255"
            y1="518"
            x2="255"
            y2="508"
            stroke="var(--accent)"
            stroke-width="1.4"
            opacity=".7"
          />
          <line
            x1="415"
            y1="518"
            x2="415"
            y2="508"
            stroke="var(--violet)"
            stroke-width="1.4"
            opacity=".7"
          />
          <line
            x1="580"
            y1="518"
            x2="580"
            y2="508"
            stroke="var(--rose)"
            stroke-width="1.4"
            opacity=".7"
          />
          <line
            x1="95"
            y1="508"
            x2="684"
            y2="508"
            stroke="var(--rose)"
            stroke-width="1.6"
            opacity=".75"
          />
          <line
            x1="684"
            y1="508"
            x2="684"
            y2="14"
            stroke="var(--rose)"
            stroke-width="1.6"
            opacity=".75"
          />
          <line
            x1="684"
            y1="14"
            x2="470"
            y2="14"
            stroke="var(--rose)"
            stroke-width="1.6"
            opacity=".75"
          />
          <line
            x1="470"
            y1="14"
            x2="470"
            y2="40"
            stroke="var(--rose)"
            stroke-width="1.6"
            opacity=".75"
            marker-end="url(#adArrowPink)"
          />

          {/* Right-channel labels — written upright so each character
              sits on its own baseline. Sideways `rotate(-90)` text was
              hard to read at small sizes, so we stack the primary
              phrase one-glyph-per-line and list the four asset kinds
              below as discrete short labels (each still rendered
              horizontally, with the lines themselves stacked). */}
          <g
            font-family="system-ui"
            text-anchor="middle"
            fill="var(--rose)"
          >
            {(isZh
              ? ["下", "次", "任", "务", "按", "需", "注", "入"]
              : ["Inject", "on", "every", "task"]
            ).map((seg, i) => (
              <text
                key={`primary-${i}`}
                x="702"
                y={68 + i * (isZh ? 19 : 22)}
                font-size={isZh ? "14" : "12"}
                font-weight="800"
              >
                {seg}
              </text>
            ))}
          </g>

          {/* Soft separator dot between the primary phrase and the
              four asset kinds — a tiny visual breathing point so the
              two label clusters don't blur into one tall column. */}
          <circle
            cx="702"
            cy={isZh ? 240 : 178}
            r="2"
            fill="color-mix(in srgb,var(--rose) 35%,transparent)"
          />

          <g
            font-family="system-ui"
            text-anchor="middle"
            fill="var(--rose)"
            font-size="12"
            font-weight="700"
          >
            {/* For ZH, every item is rendered as a stacked column of
                single characters (one <text> per glyph), grouped with
                a small gap so the four asset kinds read top-to-bottom.
                "Skill" is renamed to "技能" in ZH so the whole column
                stays consistently CJK. EN keeps a row-per-item layout
                because letter-by-letter stacking of Latin script reads
                even worse than the side-rotated original. */}
            {(() => {
              const items = isZh
                ? ["技能", "经验", "认知", "避坑规则"]
                : ["Skill", "Exp.", "Cognit.", "Repair"];
              const lineH = isZh ? 18 : 22;
              const groupGap = isZh ? 12 : 0;
              let cursor = isZh ? 268 : 206;
              const out: preact.JSX.Element[] = [];
              items.forEach((item, idx) => {
                const glyphs = isZh ? [...item] : [item];
                glyphs.forEach((g, i) => {
                  out.push(
                    <text
                      key={`item-${idx}-${i}`}
                      x="702"
                      y={cursor + i * lineH}
                    >
                      {g}
                    </text>
                  );
                });
                cursor += glyphs.length * lineH + groupGap;
              });
              return out;
            })()}
          </g>

          {/* Bottom band — soft accent wash with a 1px accent
              border. Replaces the launch-deck's heavy near-black
              fill, which clashed with the rest of the dashboard
              (and especially with dark theme). The wash + bordered
              treatment keeps it visually anchored as a "footer
              statement" without resorting to a saturated block. */}
          <rect
            x="20"
            y="624"
            width="712"
            height="28"
            rx="8"
            fill="var(--accent-soft)"
            stroke="color-mix(in srgb,var(--accent) 30%,transparent)"
            stroke-width="1"
          />
          <text
            x="376"
            y="643"
            text-anchor="middle"
            font-size="12"
            font-weight="700"
            fill="var(--accent)"
            font-family="system-ui"
          >
            {isZh
              ? "在线进化 · 不重新训练，而是持续回写长期记忆"
              : "Online evolution — never retrain; keep writing back into long-term memory"}
          </text>
      </svg>

      <p
        style="margin:18px auto 0;max-width:760px;text-align:center;font-size:12.5px;color:var(--fg-muted);line-height:1.7"
      >
        {isZh ? (
          <>
            把 Agent 的{" "}
            <b style="color:var(--accent)">每一次执行</b>{" "}
            都变成学习机会 —— 上层「做事」、中层「学习」、下层「沉淀」，三层贯通，
            <b style="color:var(--accent)">每一步都可沉淀</b>。
          </>
        ) : (
          <>
            Every{" "}
            <b style="color:var(--accent)">execution</b>{" "}
            becomes a learning opportunity — execution on top, learning in the
            middle, deposits at the bottom; all three rails wired together so{" "}
            <b style="color:var(--accent)">every step can be deposited</b>.
          </>
        )}
      </p>
    </section>
  );
}
