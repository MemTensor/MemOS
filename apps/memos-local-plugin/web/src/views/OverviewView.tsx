/**
 * Overview view — at-a-glance system health + live activity stream.
 *
 * Top row = quantity cards for the four memory layers the algorithm
 * exposes (L1 memories, tasks/episodes, L2 experiences, L3
 * environment knowledge, skills). We pull numbers from
 * `/api/v1/overview` which aggregates `listTraces / listEpisodes /
 * listPolicies / listWorldModels / listSkills`.
 *
 * Second row = the three model slots (LLM, embedder, skill evolver).
 * Each card shows the **configured model name** (not the provider
 * family) because end users pick a model, not a provider — e.g.
 * "gpt-4.1-mini", not "openai_compatible". When the skill evolver
 * inherits from the main LLM we say so explicitly.
 *
 * Third row = live SSE activity stream (unchanged).
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { openSse } from "../api/sse";
import { health } from "../stores/health";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { navigate } from "../stores/router";
import type { CoreEvent } from "../api/types";

interface SkillStats {
  total: number;
  active: number;
  candidate: number;
  archived: number;
}
interface PolicyStats {
  total: number;
  active: number;
  candidate: number;
  archived: number;
}
interface ModelInfo {
  available?: boolean;
  provider: string;
  model: string;
  dim?: number;
  inherited?: boolean;
  /** Epoch ms of most recent direct primary-provider success. */
  lastOkAt?: number | null;
  /**
   * Epoch ms of most recent rescued-by-host-fallback call. Populates
   * the "yellow" overview state.
   */
  lastFallbackAt?: number | null;
  /** Most recent failure (sticky — see ModelHealth comment). */
  lastError?: { at: number; message: string } | null;
}
interface OverviewSummary {
  ok?: boolean;
  version?: string;
  episodes?: number;
  traces?: number;
  skills?: SkillStats;
  policies?: PolicyStats;
  worldModels?: number;
  llm?: ModelInfo;
  embedder?: ModelInfo;
  skillEvolver?: ModelInfo;
}

export function OverviewView() {
  const [summary, setSummary] = useState<OverviewSummary | null>(null);
  const [recent, setRecent] = useState<CoreEvent[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      api
        .get<OverviewSummary>("/api/v1/overview", { signal: ctrl.signal })
        .then(setSummary)
        .catch(() => void 0);
    void load();
    // Re-poll every 20s so the numbers drift as the agent runs.
    const id = window.setInterval(load, 20_000);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const handle = openSse("/api/v1/events", (_, data) => {
      try {
        const evt = JSON.parse(data) as CoreEvent;
        setRecent((prev) => [evt, ...prev].slice(0, 12));
      } catch {
        /* skip */
      }
    });
    return () => handle.close();
  }, []);

  const h = health.value;
  const skills = summary?.skills;
  const policies = summary?.policies;
  // Prefer summary model info (freshly aggregated) and fall back to the
  // health ping for first-paint before `/api/v1/overview` resolves.
  const llm = summary?.llm ?? h?.llm;
  const embedder = summary?.embedder ?? h?.embedder;
  const skillEvolver = summary?.skillEvolver ?? h?.skillEvolver;

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("overview.title")}</h1>
        </div>
      </div>

      {/*
       * Row 1: layer quantities — every card is clickable and jumps to
       * the matching sidebar destination. Order matches the V7 algorithm
       * pyramid (memories → tasks → skills → experiences → environment
       * knowledge), so users see the same flow they read about in the
       * docs and the sidebar.
       */}
      {/*
       * Row 1: layer quantities — every card reserves the same
       * hint-line slot (even when empty) so the numbers line up on a
       * single baseline across the row. Without that reservation the
       * cards without hints were ~16px shorter and their values
       * floated up.
       */}
      <section class="metric-grid">
        <QuantityCard
          label={t("overview.metric.memories")}
          value={summary?.traces}
          onClick={() => navigate("/memories")}
        />
        <QuantityCard
          label={t("overview.metric.episodes")}
          value={summary?.episodes}
          onClick={() => navigate("/tasks")}
        />
        <QuantityCard
          label={t("overview.metric.skills")}
          value={skills?.total}
          hint={
            skills
              ? t("overview.metric.skills.breakdown", {
                  active: skills.active,
                  candidate: skills.candidate,
                })
              : undefined
          }
          onClick={() => navigate("/skills")}
        />
        <QuantityCard
          label={t("overview.metric.policies")}
          value={policies?.total}
          hint={
            policies
              ? t("overview.metric.policies.breakdown", {
                  active: policies.active,
                  candidate: policies.candidate,
                })
              : undefined
          }
          onClick={() => navigate("/policies")}
        />
        <QuantityCard
          label={t("overview.metric.worldModels")}
          value={summary?.worldModels}
          onClick={() => navigate("/world-models")}
        />
      </section>

      {/*
       * Row 2: model slots — show the actual model name. Each card
       * navigates to Settings → AI models so users can quickly jump from
       * "what's running" to "where to change it".
       */}
      <section class="metric-grid">
        <ModelCard
          label={t("overview.metric.embedder")}
          info={embedder}
          onClick={() => navigate("/settings", { tab: "models" })}
        />
        <ModelCard
          label={t("overview.metric.llm")}
          info={llm}
          onClick={() => navigate("/settings", { tab: "models" })}
        />
        <ModelCard
          label={t("overview.metric.skillEvolver")}
          info={skillEvolver}
          hint={
            skillEvolver?.inherited
              ? t("overview.metric.skillEvolver.inherit")
              : undefined
          }
          onClick={() => navigate("/settings", { tab: "models" })}
        />
      </section>

      <section class="card">
        <div class="card__header">
          <div>
            <h3 class="card__title">{t("overview.live.title")}</h3>
            <p class="card__subtitle">{t("overview.live.subtitle")}</p>
          </div>
        </div>
        {recent.length === 0 ? (
          <div class="empty">
            <div class="empty__icon">
              <Icon name="message-square-text" size={22} />
            </div>
            <div class="empty__title">{t("overview.live.empty")}</div>
            <div class="empty__hint">{t("overview.live.hint")}</div>
          </div>
        ) : (
          <div class="stream">
            {recent.map((evt) => (
              <div class="stream__line" key={evt.seq}>
                <span class="stream__time">{new Date(evt.ts).toLocaleTimeString()}</span>
                <span class="stream__level stream__level--info">{evt.type}</span>
                <span class="stream__body">
                  {JSON.stringify(evt.payload ?? {}).slice(0, 240)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function QuantityCard({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: number | undefined;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      class="metric metric--clickable"
      onClick={onClick}
      aria-label={label}
    >
      <div class="metric__label">{label}</div>
      <div class="metric__value">{value == null ? "—" : value}</div>
      {/*
       * Always render the hint slot so every card in a row has the
       * same vertical rhythm — the value baseline lines up across
       * sibling cards even when some have hints and others don't.
       * Non-breaking space keeps the line height when empty.
       */}
      <div class="metric__delta">{hint ?? "\u00a0"}</div>
    </button>
  );
}

type ModelDotKind = "ok" | "fallback" | "err" | "idle" | "off";

/**
 * Derive the overview card status from a {@link ModelInfo}.
 *
 * The card is painted by picking the most-recent of three timestamps
 * — `lastOkAt`, `lastFallbackAt`, `lastError.at` — and mapping that
 * winner to a colour:
 *
 *   - `ok` (green)        — primary provider answered directly.
 *   - `fallback` (yellow) — primary failed but host LLM bridge
 *                           rescued the call. The card surfaces the
 *                           original error so users know *why* it
 *                           degraded.
 *   - `err` (red)         — primary failed and either there was no
 *                           fallback or the fallback also failed.
 *
 * `lastError` is sticky on the backend so it can sit alongside a
 * fresher `lastOkAt` after recovery — comparing timestamps lets the
 * UI naturally "go green again" without having to clear the message.
 */
function modelStatusFromInfo(info: ModelInfo | undefined): {
  kind: ModelDotKind;
  label: string;
  tooltip?: string;
} {
  if (!info || info.available === false) {
    return { kind: "off", label: t("overview.metric.model.unconfigured") };
  }

  const okAt = info.lastOkAt ?? 0;
  const fbAt = info.lastFallbackAt ?? 0;
  const errAt = info.lastError?.at ?? 0;
  const max = Math.max(okAt, fbAt, errAt);

  // Nothing has happened yet — fresh process, no calls landed.
  if (max === 0) {
    return { kind: "idle", label: t("overview.metric.model.idle") };
  }

  // Priority order matters when timestamps tie.
  //
  // The backend stamps `lastFallbackAt` and `lastError.at` with the
  // SAME `Date.now()` inside `markFallback` (the upstream error is
  // kept on `lastError` so the viewer can show *why* fallback
  // engaged). When that happens, a strict "errAt === max ⇒ red"
  // check would always win over the fallback branch and the slot
  // would never go yellow. The current call succeeded — through the
  // host bridge — so semantically it is the fallback state, with
  // the error only providing context. Hence: fallback wins ties
  // against err.
  //
  // We also let fallback win ties against ok for the rare case where
  // a successful primary call and a fallback rescue happen in the
  // same millisecond — yellow is the most informative state.
  if (fbAt > 0 && fbAt >= errAt && fbAt >= okAt) {
    const raw = (info.lastError?.message ?? "").trim();
    const head = t("overview.metric.model.fallback");
    const tail = raw ? `: ${raw.length > 60 ? raw.slice(0, 59) + "…" : raw}` : "";
    return {
      kind: "fallback",
      label: head + tail,
      tooltip: raw
        ? t("overview.metric.model.fallback.tooltip", { msg: raw })
        : head,
    };
  }

  // Most recent event was a terminal failure.
  if (errAt > 0 && errAt >= okAt) {
    const raw = (info.lastError?.message ?? "").trim();
    const short =
      raw.length > 80 ? raw.slice(0, 79) + "…" : raw || t("overview.metric.model.failed");
    return {
      kind: "err",
      label: short,
      tooltip: raw || t("overview.metric.model.failed"),
    };
  }

  // okAt is the largest — primary provider is working directly.
  return {
    kind: "ok",
    label: t("overview.metric.model.connected"),
    tooltip: t("overview.metric.model.connectedAt", {
      ts: new Date(okAt).toLocaleTimeString(),
    }),
  };
}

function ModelCard({
  label,
  info,
  hint,
  onClick,
}: {
  label: string;
  info: ModelInfo | undefined;
  hint?: string;
  onClick?: () => void;
}) {
  const model = (info?.model ?? "").trim();
  const display = model ? model : t("overview.metric.model.unconfigured");
  const status = modelStatusFromInfo(info);
  const titleAttr = status.tooltip
    ? `${model || label}\n\n${status.tooltip}`
    : model || label;
  return (
    <button
      type="button"
      class="metric metric--clickable"
      onClick={onClick}
      aria-label={label}
      title={titleAttr}
    >
      <div
        class="metric__label"
        style="display:flex;align-items:center;gap:6px;justify-content:center"
      >
        <span class={`status-dot status-dot--${status.kind}`} aria-hidden="true" />
        {label}
      </div>
      <div
        class="metric__value"
        style="font-size:var(--fs-lg);font-family:var(--font-mono, monospace);word-break:break-all"
        title={model || label}
      >
        {display}
      </div>
      <div class="metric__delta">
        {[status.label, hint].filter(Boolean).join(" · ") || info?.provider || "—"}
      </div>
    </button>
  );
}
