/* Shared helpers + mock data for the "实时活动" demos.
 * Pure vanilla JS, drag any of the option-*.html files into a browser
 * and it just works (no bundler required).
 *
 * Everything is wrapped in an IIFE so we don't leak names like
 * `renderIcon` / `decorate` into the global scope — otherwise the
 * inline `<script>`s on each demo page (which destructure those names
 * from `window.DEMO`) would collide with the same identifiers and the
 * page would die with `SyntaxError: Identifier 'renderIcon' has
 * already been declared`. Only `window.DEMO` is exposed.
 */
(function () {
"use strict";

// ── Lucide-style inline SVG paths (subset we need) ─────────────────
const ICONS = {
  "message-square-text":
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/>',
  "cpu":
    '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 14h3"/><path d="M1 9h3"/><path d="M1 14h3"/>',
  "globe":
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20"/><path d="M12 2a14.5 14.5 0 0 1 0 20"/><path d="M2 12h20"/>',
  "sparkles":
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  "search":
    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "workflow":
    '<rect x="3" y="3" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
  "share-2":
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  "zap":
    '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  "circle-alert":
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  "gauge":
    '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  "archive":
    '<rect x="2" y="4" width="20" height="5" rx="2"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  "clock":
    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  "settings-2":
    '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  "check-circle-2":
    '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  "wrench":
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  "layers":
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  "brain-circuit":
    '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M12 13h4"/><path d="M12 18h6a2 2 0 0 1 2 2v1"/><path d="M12 8h8"/><path d="M16 8V5a2 2 0 0 1 2-2"/><circle cx="16" cy="13" r=".5"/><circle cx="18" cy="3" r=".5"/><circle cx="20" cy="21" r=".5"/><circle cx="20" cy="8" r=".5"/>',
};

function renderIcon(name) {
  const inner = ICONS[name] || ICONS["circle-alert"];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

// ── Categories ────────────────────────────────────────────────────
// Names mirror the product's i18n labels:
//   L2 policies → "经验" (NOT 策略)
//   L3 worldModels → "环境认知" (NOT 世界观)
// Source: web/src/stores/i18n.ts → `overview.metric.*` zh-CN block.
const CAT = {
  session:   { name: "对话",     icon: "message-square-text" },
  memory:    { name: "记忆",     icon: "brain-circuit" },
  policy:    { name: "经验",     icon: "workflow" },
  world:     { name: "环境认知", icon: "globe" },
  skill:     { name: "技能",     icon: "sparkles" },
  retrieval: { name: "检索",     icon: "search" },
  feedback:  { name: "反馈",     icon: "check-circle-2" },
  system:    { name: "系统",     icon: "settings-2" },
};

const TYPE2CAT = {
  "session.opened":              "session",
  "session.closed":              "session",
  "episode.opened":              "session",
  "episode.closed":              "session",
  "trace.created":               "memory",
  "trace.value_updated":         "memory",
  "trace.priority_decayed":      "memory",
  "l2.candidate_added":          "policy",
  "l2.induced":                  "policy",
  "l2.associated":               "policy",
  "l2.revised":                  "policy",
  "l3.abstracted":               "world",
  "l3.revised":                  "world",
  "skill.crystallized":          "skill",
  "skill.eta_updated":           "skill",
  "skill.archived":              "skill",
  "skill.repaired":              "skill",
  "retrieval.triggered":         "retrieval",
  "retrieval.tier1.hit":         "retrieval",
  "retrieval.tier2.hit":         "retrieval",
  "retrieval.empty":             "retrieval",
  "feedback.classified":         "feedback",
  "reward.computed":             "feedback",
  "decision_repair.generated":   "feedback",
  "system.started":              "system",
  "system.config_changed":       "system",
  "system.error":                "system",
};

// Type-specific icon overrides (otherwise we fall back to category icon).
const TYPE_ICON = {
  "trace.value_updated":      "refresh-cw",
  "trace.priority_decayed":   "clock",
  "l2.induced":               "sparkles",
  "l2.associated":            "layers",
  "l2.revised":               "refresh-cw",
  "skill.crystallized":       "sparkles",
  "skill.eta_updated":        "gauge",
  "skill.archived":           "archive",
  "skill.repaired":           "wrench",
  "decision_repair.generated":"wrench",
  "reward.computed":          "check-circle-2",
  "feedback.classified":      "share-2",
  "system.started":           "zap",
  "system.error":             "circle-alert",
  "system.config_changed":    "settings-2",
  "retrieval.empty":          "search",
};

// Tone hint — drives accent colour for items where the category alone
// isn't enough (system error, decay, archive, empty retrieval, …).
const TYPE_TONE = {
  "system.error":           "err",
  "trace.priority_decayed": "warn",
  "skill.archived":         "warn",
  "retrieval.empty":        "warn",
  "skill.crystallized":     "good",
  "l2.induced":             "good",
  "l3.abstracted":          "good",
  "reward.computed":        "good",
  "system.started":         "good",
};

// Title + detail per event type. Titles are NOUN+VERB compounds
// (e.g. "记忆存储" / "经验生成"), the same telegraphic style operations
// logs use. Detail is the lightest specific identifier we can show
// (id / count / similarity) so each row stays scannable.
// Vocabulary aligned with the product's i18n labels (经验, 环境认知, …).
const NARRATIVE = {
  "session.opened":             (p) => ({ title: "对话开启",         detail: `会话 ${p.id ?? "—"}` }),
  "session.closed":             (p) => ({ title: "对话结束",         detail: `会话 ${p.sessionId ?? "—"} · ${p.reason ?? "user-closed"}` }),
  "episode.opened":             (p) => ({ title: "任务开始",         detail: `任务 ${p.id ?? "—"}` }),
  "episode.closed":             (p) => ({ title: "任务结束",         detail: `任务 ${p.episode?.id ?? p.episodeId ?? "—"} · ${p.closedBy ?? "system"}` }),
  "trace.created":              (p) => ({ title: "记忆存储",         detail: `记忆 ${p.traceId ?? "—"}` }),
  "trace.value_updated":        (p) => ({ title: "记忆更新",         detail: `记忆 ${p.traceId ?? "—"}` }),
  "trace.priority_decayed":     (p) => ({ title: "记忆衰减",         detail: `记忆 ${p.traceId ?? "—"}` }),
  "l2.candidate_added":         (p) => ({ title: "候选经验新增",     detail: `候选 ${p.signature ?? "—"}` }),
  "l2.induced":                 (p) => ({ title: "经验生成",         detail: `${p.signature ?? "—"} · 来自 ${p.evidenceCount ?? "?"} 次成功任务` }),
  "l2.associated":              (p) => ({ title: "经验关联",         detail: `经验 ${p.policyId ?? "—"} · 相似度 ${Math.round((p.similarity ?? 0) * 100)}%` }),
  "l2.revised":                 (p) => ({ title: "经验修订",         detail: `经验 ${p.policyId ?? "—"}` }),
  "l3.abstracted":              (p) => ({ title: "环境认知生成",     detail: `环境认知 ${p.worldModelId ?? "—"}` }),
  "l3.revised":                 (p) => ({ title: "环境认知更新",     detail: `环境认知 ${p.worldModelId ?? "—"}` }),
  "skill.crystallized":         (p) => ({ title: "技能晶化",         detail: `技能 ${p.skillId ?? "—"}` }),
  "skill.eta_updated":          (p) => ({ title: "技能预期更新",     detail: `技能 ${p.skillId ?? "—"}` }),
  "skill.archived":             (p) => ({ title: "技能归档",         detail: `技能 ${p.skillId ?? "—"}` }),
  "skill.repaired":             (p) => ({ title: "技能修复",         detail: `技能 ${p.skillId ?? "—"}` }),
  "retrieval.triggered":        (p) => ({ title: "检索触发",         detail: `会话 ${p.sessionId ?? "—"}` }),
  "retrieval.tier1.hit":        (p) => ({ title: "第一层检索命中",   detail: `命中 ${p.count} 条 · ${p.ms}ms` }),
  "retrieval.tier2.hit":        (p) => ({ title: "第二层检索命中",   detail: `命中 ${p.count} 条 · ${p.ms}ms` }),
  "retrieval.empty":            (p) => ({ title: "检索无结果",       detail: `会话 ${p.sessionId ?? "—"}` }),
  "feedback.classified":        (p) => ({ title: "反馈分类",         detail: `情绪 ${p.tone ?? "neutral"}` }),
  "reward.computed":            (p) => ({ title: "奖励计算",         detail: `r = ${(p.rHuman ?? 0).toFixed(2)} · 来自 ${p.source ?? "—"}` }),
  "decision_repair.generated":  (p) => ({ title: "决策修补",         detail: `修补 ${p.repairId ?? "—"}` }),
  "system.started":             (p) => ({ title: "系统启动",         detail: `v${p.version ?? "—"}` }),
  "system.config_changed":      (p) => ({ title: "配置变更",         detail: `${p.key ?? "—"}` }),
  "system.error":               (p) => ({ title: "系统异常",         detail: p.message ?? "未知错误" }),
};

function decorate(evt) {
  const cat = TYPE2CAT[evt.type] ?? "system";
  const tone = TYPE_TONE[evt.type] ?? "info";
  const icon = TYPE_ICON[evt.type] ?? CAT[cat].icon;
  const fmt = NARRATIVE[evt.type];
  const { title, detail } = fmt
    ? fmt(evt.payload ?? {})
    : { title: evt.type, detail: JSON.stringify(evt.payload ?? {}).slice(0, 80) };
  return { ...evt, cat, tone, icon, title, detail };
}

// ── Mock event sequence ───────────────────────────────────────────
// dt = seconds before "now" when the event happened. The newest
// (closest to 0) sit at the top of the feed. The list is kept dense
// enough that pulse / sparkline visuals look interesting.
const MOCK_RAW = [
  { dt: -298, type: "system.started",              payload: { version: "2.0.0-beta.5" } },
  { dt: -270, type: "session.opened",              payload: { id: "sess_8x32" } },
  { dt: -266, type: "episode.opened",              payload: { id: "ep_a1c2" } },
  { dt: -260, type: "retrieval.triggered",         payload: { sessionId: "sess_8x32" } },
  { dt: -258, type: "retrieval.tier1.hit",         payload: { count: 5, ms: 41 } },
  { dt: -240, type: "trace.created",               payload: { traceId: "tr_1f4", episodeId: "ep_a1c2" } },
  { dt: -230, type: "trace.created",               payload: { traceId: "tr_1f5", episodeId: "ep_a1c2" } },
  { dt: -210, type: "feedback.classified",         payload: { tone: "satisfied" } },
  { dt: -205, type: "reward.computed",             payload: { rHuman: 0.82, source: "explicit" } },
  { dt: -190, type: "l2.associated",               payload: { policyId: "pol_31a", similarity: 0.74 } },
  { dt: -178, type: "l2.candidate_added",          payload: { signature: "ask-then-search" } },
  { dt: -160, type: "l2.induced",                  payload: { signature: "ask-then-search", evidenceCount: 3 } },
  { dt: -145, type: "trace.value_updated",         payload: { traceId: "tr_1f4" } },
  { dt: -132, type: "retrieval.triggered",         payload: { sessionId: "sess_8x32" } },
  { dt: -130, type: "retrieval.tier2.hit",         payload: { count: 2, ms: 82 } },
  { dt: -118, type: "skill.eta_updated",           payload: { skillId: "sk_search-by-time" } },
  { dt: -100, type: "trace.priority_decayed",      payload: { traceId: "tr_0c3" } },
  { dt:  -88, type: "skill.crystallized",          payload: { skillId: "sk_summarise-topic" } },
  { dt:  -75, type: "l3.abstracted",               payload: { worldModelId: "wm_topic-prefs" } },
  { dt:  -68, type: "decision_repair.generated",   payload: { repairId: "rep_4f" } },
  { dt:  -55, type: "trace.created",               payload: { traceId: "tr_1f6", episodeId: "ep_a1c2" } },
  { dt:  -42, type: "retrieval.empty",             payload: { sessionId: "sess_8x32" } },
  { dt:  -36, type: "system.config_changed",       payload: { key: "embedder.dim" } },
  { dt:  -30, type: "skill.archived",              payload: { skillId: "sk_legacy-v0" } },
  { dt:  -22, type: "l2.revised",                  payload: { policyId: "pol_31a" } },
  { dt:  -18, type: "trace.created",               payload: { traceId: "tr_1f7", episodeId: "ep_a1c2" } },
  { dt:  -12, type: "retrieval.triggered",         payload: { sessionId: "sess_8x32" } },
  { dt:  -10, type: "retrieval.tier1.hit",         payload: { count: 8, ms: 38 } },
  { dt:   -5, type: "feedback.classified",         payload: { tone: "neutral" } },
  { dt:   -2, type: "reward.computed",             payload: { rHuman: 0.74, source: "implicit" } },
];

// Materialise into events with absolute ts (epoch ms) at page-load
// time. A monotonic seq is appended for stable React-like keys.
function buildMockEvents() {
  const now = Date.now();
  return MOCK_RAW.map((e, i) => ({
    seq: i + 1,
    ts: now + e.dt * 1000,
    type: e.type,
    payload: e.payload,
  }));
}

// ── Time helpers ──────────────────────────────────────────────────
function relativeTime(ts) {
  const diff = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diff < 5) return "刚刚";
  if (diff < 60) return `${diff} 秒前`;
  const m = Math.round(diff / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return `${d} 天前`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── Static "system overview" upper rows, identical across demos ──
// Labels mirror the zh-CN product i18n: 记忆数量 / 任务数量 / 技能数量 /
// 经验数量 / 环境认知数量. We strip the trailing "数量" because the demo
// is an at-a-glance card; the value already implies a count.
function renderOverviewHeader(targetEl) {
  targetEl.innerHTML = `
    <div class="view-header"><h1>系统总览</h1></div>

    <section class="metric-grid">
      ${[
        { label: "记忆",     v: 1284, hint: "条记忆" },
        { label: "任务",     v: 162,  hint: "段任务" },
        { label: "技能",     v: 14,   hint: "9 已启用 · 5 候选" },
        { label: "经验",     v: 27,   hint: "12 已启用 · 15 候选" },
        { label: "环境认知", v: 6,    hint: "条认知" },
      ].map(m => `
        <div class="metric">
          <div class="metric__label">${m.label}</div>
          <div class="metric__value">${m.v}</div>
          <div class="metric__delta">${m.hint}</div>
        </div>
      `).join("")}
    </section>

    <section class="metric-grid">
      ${[
        { label: "Embedder",      model: "bge-m3",       hint: "已连接 · 14:21:08" },
        { label: "LLM",           model: "gpt-4.1-mini", hint: "已连接 · 14:22:41" },
        { label: "Skill Evolver", model: "gpt-4.1-mini", hint: "已连接 · 继承自主 LLM" },
      ].map(m => `
        <div class="metric">
          <div class="metric__label" style="display:flex;align-items:center;gap:6px;justify-content:center">
            <span class="status-dot status-dot--ok" aria-hidden="true"></span>${m.label}
          </div>
          <div class="metric__value" style="font-size:var(--fs-lg);font-family:var(--font-mono, monospace);word-break:break-all;text-align:center">${m.model}</div>
          <div class="metric__delta" style="text-align:center">${m.hint}</div>
        </div>
      `).join("")}
    </section>
  `;
}

// ── Theme toggle wired into the demo banner ──────────────────────
// Mirrors the product's theme switch (light / dark / auto). We don't
// need the `auto` mode in the demo — light vs. dark is enough.
function installThemeToggle(targetEl) {
  const KEY = "memos-demo.theme";
  const saved = (() => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  })();
  const initial = saved === "dark" || saved === "light"
    ? saved
    : (document.documentElement.dataset.theme || "light");
  apply(initial);

  function apply(mode) {
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
    if (targetEl) {
      targetEl.querySelectorAll("button[data-theme-btn]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.themeBtn === mode);
      });
    }
  }

  if (!targetEl) return;
  targetEl.innerHTML = `
    <span style="font-size:var(--fs-2xs);color:var(--fg-muted);text-transform:uppercase;letter-spacing:.06em;margin-right:4px">主题</span>
    <button type="button" data-theme-btn="light" title="浅色">
      ${renderIcon("sun")}
    </button>
    <button type="button" data-theme-btn="dark" title="深色">
      ${renderIcon("moon")}
    </button>
  `;
  targetEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-theme-btn]");
    if (btn) apply(btn.dataset.themeBtn);
  });
  apply(initial);
}

// sun / moon icons for the toggle (small additions to the registry)
ICONS["sun"] = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';
ICONS["moon"] = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';

// ── Render a friendly activity feed inline (Option A core) ───────
// Used by both the standalone option-a.html and the live preview on
// the index page so all three previews share the same exact code.
function renderFeedInto(targetEl, events, { limit = 12 } = {}) {
  const list = events.slice().sort((a, b) => b.ts - a.ts).slice(0, limit).map(decorate);
  targetEl.innerHTML = list.map((e) => `
    <div class="feed__item cat--${e.cat} ${e.tone !== "info" ? "tone--" + e.tone : ""}"
         role="button" tabindex="0"
         data-seq="${e.seq}"
         title="${e.type}\n${fmtClock(e.ts)}\n${escapeHtml(JSON.stringify(e.payload, null, 2))}">
      <div class="feed__icon">${renderIcon(e.icon)}</div>
      <div class="feed__main">
        <div class="feed__title">
          <span>${escapeHtml(e.title)}</span>
          <span class="feed__cat">${CAT[e.cat].name}</span>
        </div>
        <div class="feed__detail">${escapeHtml(e.detail)}</div>
        <div class="feed__raw">${escapeHtml(JSON.stringify(e.payload, null, 2))}</div>
      </div>
      <div class="feed__time" data-ts="${e.ts}">${relativeTime(e.ts)}</div>
    </div>
  `).join("");
  targetEl.addEventListener("click", (ev) => {
    const item = ev.target.closest(".feed__item");
    if (item) item.classList.toggle("is-open");
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Expose globally for the per-page scripts.
window.DEMO = {
  ICONS, renderIcon, CAT, TYPE2CAT, TYPE_ICON, TYPE_TONE,
  NARRATIVE, decorate,
  buildMockEvents, relativeTime, fmtClock,
  renderOverviewHeader,
  installThemeToggle,
  renderFeedInto,
  escapeHtml,
};

})();
