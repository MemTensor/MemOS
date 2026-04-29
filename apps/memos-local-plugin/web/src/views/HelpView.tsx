/**
 * Help view — user-facing documentation for every metadata field.
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
}

function getSections(isZh: boolean): HelpSection[] {
  return [
    {
      icon: "brain-circuit",
      title: isZh ? "记忆" : "Memories",
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
              ? "了解面板里每个数值、状态和流水线的含义。"
              : "Learn what every score, status and pipeline in the viewer means."}
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

      {/* Retrieval explainer card */}
      <section
        class="card"
        style="border-left:3px solid var(--accent);margin-bottom:var(--sp-5)"
      >
        <h3 class="card__title" style="margin-bottom:var(--sp-2)">
          {isZh ? "系统如何在新任务中复用已有知识" : "How the system reuses knowledge in new tasks"}
        </h3>
        <p class="card__subtitle" style="margin-bottom:var(--sp-3);max-width:780px">
          {isZh
            ? "当新任务到来时，系统会自动从三层存储中检索最相关的内容，注入给助手作为参考。经验不直接参与检索，而是通过结晶成技能后间接生效。"
            : "When a new task arrives, the system retrieves the most relevant content from three storage layers and injects it into the assistant's context."}
        </p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--sp-3)">
          {[
            {
              icon: "wand-sparkles" as IconName,
              label: isZh ? "技能召回" : "Skill recall",
              desc: isZh ? "匹配到的技能整体注入（包含经验的全部四要素 + 决策指引）" : "Matched skills are injected with their full invocation guide",
              color: "var(--violet)",
              bg: "var(--violet-bg)",
            },
            {
              icon: "brain-circuit" as IconName,
              label: isZh ? "记忆召回" : "Memory recall",
              desc: isZh ? "相似的历史记忆按价值排序注入，作为具体参考" : "Similar past memories ranked by value",
              color: "var(--cyan)",
              bg: "var(--cyan-bg)",
            },
            {
              icon: "globe" as IconName,
              label: isZh ? "环境认知召回" : "Environment recall",
              desc: isZh ? "匹配到的环境知识注入，帮助助手直接导航" : "Matched environment knowledge for direct navigation",
              color: "var(--green)",
              bg: "var(--green-bg)",
            },
          ].map((item) => (
            <div
              key={item.label}
              style={`background:${item.bg};border-radius:var(--radius-md);padding:var(--sp-4);display:flex;flex-direction:column;gap:var(--sp-2)`}
            >
              <div style="display:flex;align-items:center;gap:var(--sp-2)">
                <Icon name={item.icon} size={16} />
                <span style={`font-weight:var(--fw-semi);color:${item.color}`}>
                  {item.label}
                </span>
              </div>
              <span style="font-size:var(--fs-xs);color:var(--fg-muted);line-height:1.5">
                {item.desc}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Evolution pipeline — visual card */}
      <section class="card" style="margin-bottom:var(--sp-5)">
        <h3 class="card__title" style="margin-bottom:var(--sp-3)">
          {isZh ? "进化链路" : "Evolution pipeline"}
        </h3>
        <div
          style="display:flex;align-items:center;justify-content:center;gap:0;flex-wrap:wrap;padding:var(--sp-3) 0"
        >
          {[
            { icon: "brain-circuit" as IconName, label: isZh ? "记忆" : "Memory", color: "var(--cyan)", bg: "var(--cyan-bg)" },
            { icon: "sparkles" as IconName, label: isZh ? "经验" : "Experience", color: "var(--amber)", bg: "var(--amber-bg)" },
            { icon: "globe" as IconName, label: isZh ? "环境认知" : "Env. Knowledge", color: "var(--green)", bg: "var(--green-bg)" },
            { icon: "wand-sparkles" as IconName, label: isZh ? "技能" : "Skill", color: "var(--violet)", bg: "var(--violet-bg)" },
          ].map((step, i, arr) => (
            <>
              <div
                key={step.label}
                style={`display:flex;flex-direction:column;align-items:center;gap:6px;padding:var(--sp-3) var(--sp-4);background:${step.bg};border-radius:var(--radius-md);min-width:100px`}
              >
                <div
                  style={`width:40px;height:40px;border-radius:10px;background:${step.bg};border:2px solid ${step.color};display:flex;align-items:center;justify-content:center`}
                >
                  <Icon name={step.icon} size={20} />
                </div>
                <span
                  style={`font-size:var(--fs-sm);font-weight:var(--fw-semi);color:${step.color}`}
                >
                  {step.label}
                </span>
              </div>
              {i < arr.length - 1 && (
                <span
                  key={`arrow-${i}`}
                  style="color:var(--fg-dim);font-size:20px;padding:0 var(--sp-1);flex-shrink:0"
                >
                  →
                </span>
              )}
            </>
          ))}
        </div>
        <p
          class="muted"
          style="text-align:center;font-size:var(--fs-xs);margin:var(--sp-2) 0 0 0;max-width:600px;margin-left:auto;margin-right:auto;line-height:1.6"
        >
          {isZh
            ? "交互产生记忆 → 跨任务归纳出经验 → 多条经验抽象成环境认知 → 达标后结晶成技能。用户反馈可反向修订任何一层。"
            : "Interactions produce memories → cross-task induction forms experiences → experiences abstract into environment knowledge → crystallized into skills. User feedback can revise any layer."}
        </p>
      </section>

      {/* Per-section field docs */}
      <div class="vstack" style="gap:var(--sp-5)">
        {SECTIONS.map((sec) => (
          <section class="card" key={sec.title}>
            <div
              class="card__header"
              style="margin-bottom:var(--sp-3);align-items:center"
            >
              <div class="hstack" style="gap:var(--sp-3);align-items:center">
                <span
                  style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:var(--accent-soft);color:var(--accent);flex-shrink:0"
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
              style="display:grid;grid-template-columns:280px 1fr;gap:var(--sp-3) var(--sp-5);margin:0;font-size:var(--fs-sm);line-height:1.6"
            >
              {sec.fields.map((f) => (
                <>
                  <dt
                    key={`dt-${f.label}`}
                    style="display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-weight:var(--fw-semi);color:var(--fg)"
                  >
                    <span>{f.label}</span>
                    {f.hint && (
                      <span
                        class="muted mono"
                        style="font-size:var(--fs-2xs);font-weight:var(--fw-med);white-space:nowrap"
                      >
                        {f.hint}
                      </span>
                    )}
                  </dt>
                  <dd key={`dd-${f.label}`} style="margin:0;color:var(--fg-muted)">
                    {f.desc}
                  </dd>
                </>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </>
  );
}
