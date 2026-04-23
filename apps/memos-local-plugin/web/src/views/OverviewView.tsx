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
  /** Epoch ms of most recent successful call (null = never called). */
  lastOkAt?: number | null;
  /** Most recent failure, if the last call went bad. */
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

type ModelDotKind = "ok" | "err" | "idle" | "off";

/**
 * Derive the overview card status from a {@link ModelInfo}:
 *   - `off`  — the client isn't even configured
 *   - `idle` — configured but no call has happened yet (fresh install)
 *   - `err`  — last call failed, surface the error message in a tooltip
 *   - `ok`   — last call succeeded
 *
 * Preference order: error wins (even over never-called), so a
 * freshly-failed provider doesn't pretend to be idle.
 */
function modelStatusFromInfo(info: ModelInfo | undefined): {
  kind: ModelDotKind;
  label: string;
  tooltip?: string;
} {
  if (!info || info.available === false) {
    return { kind: "off", label: t("overview.metric.model.unconfigured") };
  }
  if (info.lastError) {
    return {
      kind: "err",
      label: t("overview.metric.model.failed"),
      tooltip: info.lastError.message,
    };
  }
  if (info.lastOkAt) {
    return {
      kind: "ok",
      label: t("overview.metric.model.connected"),
      tooltip: t("overview.metric.model.connectedAt", {
        ts: new Date(info.lastOkAt).toLocaleTimeString(),
      }),
    };
  }
  return { kind: "idle", label: t("overview.metric.model.idle") };
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
