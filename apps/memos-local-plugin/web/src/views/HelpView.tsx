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

const SECTIONS: HelpSection[] = [
  {
    icon: "brain-circuit",
    title: "记忆",
    intro:
      "记忆页展示每一步执行的原始记录。每条记忆带有系统自动回填的数值信号，代表这条记忆的重要性和权重。",
    fields: [
      {
        label: "价值 V",
        hint: "[-1, 1]",
        desc: "这条记忆对任务成功的贡献程度。正值 = 有帮助，负值 = 反例；绝对值越大权重越大。",
      },
      {
        label: "反思权重 α",
        hint: "[0, 1]",
        desc: "这一步反思的质量。识别出关键发现的步骤 α 高（0.6–0.8），正常推进中等（0.3–0.5），盲目试错低（0–0.2）。",
      },
      {
        label: "用户反馈分 R_human",
        hint: "[-1, 1]",
        desc: "用户对整个任务的满意度评分。只在用户给出明确反馈后才会出现。",
      },
      {
        label: "优先级",
        desc: "检索排序权重。价值高且较新的记忆优先级高、被召回的机会更大；老旧或低价值记忆自然下沉但不会被删除。",
      },
      {
        label: "本任务的其他步骤",
        desc: "同一个任务下，按时间顺序排列的其他步骤记忆。",
      },
    ],
  },
  {
    icon: "list-checks",
    title: "任务",
    intro:
      "任务页展示每一段聚焦的对话（一次完整的问→答过程）。点击可以看到完整对话和对应的技能流水线进度。",
    fields: [
      {
        label: "状态",
        desc:
          "进行中 / 已完成 / 已跳过 / 失败。已跳过 = 对话过短无法形成有效记忆。失败 = 评分为负，本任务的记录会作为反例保留。",
      },
      {
        label: "技能流水线",
        desc:
          "代表本任务在技能结晶流水线上的状态：等待中 / 生成中 / 已生成 / 已升级 / 未达沉淀阈值。",
      },
      { label: "任务评分 R_task", desc: "用户满意度的数值化表达。正值越大 = 越满意。" },
      { label: "对话轮次", desc: "本任务的问答轮数。" },
    ],
  },
  {
    icon: "wand-sparkles",
    title: "技能",
    intro:
      "技能是从经验中结晶出来的可调用能力。当新任务到来时，系统会自动匹配最相关的技能并注入给助手。",
    fields: [
      { label: "状态", desc: "已启用 = 已通过验证可被调用；候选 = 还在等待更多证据；已归档 = 已停用不参与检索。" },
      { label: "可靠性 η", desc: "调用这条技能比不调用时的平均效果提升。η 越高越值得调用。" },
      { label: "增益 gain", desc: "结晶时统计的策略平均收益。" },
      { label: "支撑任务数 support", desc: "有多少个独立任务支撑了这条技能。" },
      { label: "版本 version", desc: "每次重建 +1。" },
      {
        label: "进化时间线",
        desc: "记录技能生命周期：开始结晶 → 结晶完成 → 重建 → η 更新 → 状态变更 → 归档。",
      },
    ],
  },
  {
    icon: "sparkles",
    title: "经验",
    intro:
      "经验是从多个相似任务中归纳出的可复用策略。它不直接注入给助手，而是通过结晶成技能后间接生效。",
    fields: [
      { label: "触发 trigger", desc: "在什么场景下应该启用这条经验。" },
      { label: "流程 procedure", desc: "应该执行什么步骤。" },
      { label: "验证 verification", desc: "怎么判断这条经验是否被成功执行。" },
      { label: "边界 boundary", desc: "适用范围和排除范围。" },
      { label: "支撑任务数 / 增益", desc: "支撑的独立任务数和平均价值增益。用于决定是否结晶为技能。" },
      {
        label: "决策指引（推荐做法 / 避免做法）",
        desc:
          "系统从用户反馈中提取的行动建议。同一场景下不同做法的效果显著分化时，自动生成「优先做 X，避免做 Y」。",
      },
    ],
  },
  {
    icon: "globe",
    title: "环境认知",
    intro:
      "环境认知是系统对你工作环境的压缩理解。有了它，助手可以直接凭记忆导航而不必每次重新探索。",
    fields: [
      { label: "空间结构", desc: "环境中什么东西在哪 — 目录、服务拓扑、配置文件位置等。" },
      { label: "行为规律", desc: "环境对动作的典型响应 — 如「这个 API 返回 JSON」「构建必须先 compile 再 link」。" },
      { label: "约束与禁忌", desc: "什么不能做 — 如「这个目录是只读的」「Alpine 上别用 binary wheel」。" },
      { label: "关联经验数", desc: "支撑这条认知的经验数量。数量越多说明该结构越稳定。" },
    ],
  },
];

export function HelpView() {
  const isZh = locale.value === "zh";
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
