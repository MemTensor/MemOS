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
 * Third row = live activity dashboard. Six per-category tiles
 * (memory / experience / environment knowledge / skill / retrieval /
 * feedback) each showing a 5-minute event count, sparkline, and the
 * most recent event in plain language. Tiles are bucketed off the
 * same SSE buffer (`recent`) we already maintain. See
 * `views/overview/ActivityDashboard.tsx` for the renderer and
 * `views/overview/event-meta.ts` for the event-type → tile mapping.
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { openSse } from "../api/sse";
import { health } from "../stores/health";
import { t } from "../stores/i18n";
import { navigate } from "../stores/router";
import type { ApiLogDTO, CoreEvent, CoreEventType } from "../api/types";
import { ActivityDashboard } from "./overview/ActivityDashboard";

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

interface ApiLogsResponse {
  logs: ApiLogDTO[];
}

export function OverviewView() {
  const [summary, setSummary] = useState<OverviewSummary | null>(null);
  const [recent, setRecent] = useState<CoreEvent[]>([]);
  const [recentApiLogEvents, setRecentApiLogEvents] = useState<CoreEvent[]>([]);

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
    // The dashboard buckets events into a 5-minute sliding window
    // (30 buckets × 10 s). Cap the buffer at 256 so we keep enough
    // history even on chatty agents (trace + retrieval + feedback can
    // each fire several times per minute) without growing unbounded.
    const handle = openSse("/api/v1/events", (_, data) => {
      try {
        const evt = JSON.parse(data) as CoreEvent;
        setRecent((prev) => [evt, ...prev].slice(0, 256));
      } catch {
        /* skip */
      }
    });
    return () => handle.close();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      api
        .get<ApiLogsResponse>("/api/v1/api-logs?limit=200&offset=0", {
          signal: ctrl.signal,
        })
        .then((res) => {
          setRecentApiLogEvents(
            (res.logs ?? [])
              .map(apiLogToCoreEvent)
              .filter((evt): evt is CoreEvent => evt !== null),
          );
        })
        .catch(() => void 0);
    void load();
    // api_logs is the durable source behind the Logs page. Polling it
    // keeps the overview heartbeat alive even when the volatile CoreEvent
    // SSE stream misses a lifecycle event or the viewer connects late.
    const id = window.setInterval(load, 10_000);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
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

      {/*
       * Row 3: live activity dashboard. Replaces the previous JSON
       * `.stream` block with a 3 × 2 grid of category tiles
       * (memory / experience / environment knowledge / skill /
       * retrieval / feedback) each showing a 5-minute sparkline plus
       * the latest event in plain language. The component owns its
       * own clock tick so sparklines slide left even while the SSE
       * stream is quiet.
       */}
      <section class="card card--flat">
        <div class="card__header">
          <div>
            <h3 class="card__title">{t("overview.live.title")}</h3>
          </div>
        </div>
        <ActivityDashboard events={mergeRecentEvents(recent, recentApiLogEvents)} />
      </section>
    </>
  );
}

function mergeRecentEvents(
  liveEvents: readonly CoreEvent[],
  apiLogEvents: readonly CoreEvent[],
): CoreEvent[] {
  const byKey = new Map<string, CoreEvent>();
  for (const evt of [...apiLogEvents, ...liveEvents]) {
    const id = evt.correlationId ?? evt.seq;
    byKey.set(`${evt.type}:${id}:${evt.ts}`, evt);
  }
  return [...byKey.values()].sort((a, b) => b.ts - a.ts).slice(0, 512);
}

function apiLogToCoreEvent(log: ApiLogDTO): CoreEvent | null {
  const output = parseJsonObject(log.outputJson);
  const input = parseJsonObject(log.inputJson);
  const basePayload = {
    apiLogId: log.id,
    toolName: log.toolName,
    success: log.success,
    durationMs: log.durationMs,
    input,
    output,
  };
  const type = apiLogEventType(log, output);
  if (!type) return null;
  return {
    type,
    ts: log.calledAt,
    seq: -1_000_000 - log.id,
    correlationId: apiLogCorrelationId(log, input, output),
    payload: apiLogPayload(log, type, basePayload, input, output),
  };
}

function apiLogEventType(
  log: ApiLogDTO,
  output: Record<string, unknown>,
): CoreEventType | null {
  switch (log.toolName) {
    case "memory_add":
      return "trace.created";
    case "memory_search":
      return hasRetrievalHits(output) ? "retrieval.tier1.hit" : "retrieval.empty";
    case "policy_generate":
      return "l2.induced";
    case "policy_evolve":
      return "l2.revised";
    case "world_model_generate":
      return "l3.abstracted";
    case "world_model_evolve":
      return "l3.revised";
    case "skill_generate":
      return "skill.crystallized";
    case "skill_evolve":
      return skillEventType(output);
    default:
      return null;
  }
}

function skillEventType(output: Record<string, unknown>): CoreEventType {
  const kind = stringField(output, "kind");
  if (kind === "skill.archived") return "skill.archived";
  if (kind === "skill.eta.updated") return "skill.eta_updated";
  return "skill.repaired";
}

function apiLogCorrelationId(
  log: ApiLogDTO,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): string {
  return (
    stringField(output, "traceId") ??
    stringField(output, "policyId") ??
    stringField(output, "worldModelId") ??
    stringField(output, "skillId") ??
    stringField(input, "episodeId") ??
    stringField(input, "sessionId") ??
    `api-log-${log.id}`
  );
}

function apiLogPayload(
  log: ApiLogDTO,
  type: CoreEventType,
  basePayload: Record<string, unknown>,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "trace.created") {
    const details = Array.isArray(output.details) ? output.details : [];
    const firstDetail =
      details.find((item): item is Record<string, unknown> => !!item && typeof item === "object") ??
      {};
    return {
      ...basePayload,
      traceId: stringField(firstDetail, "traceId") ?? `api-log-${log.id}`,
      episodeId: stringField(input, "episodeId"),
      sessionId: stringField(input, "sessionId"),
    };
  }
  if (type === "retrieval.tier1.hit" || type === "retrieval.empty") {
    const hits = retrievalHitCount(output);
    return {
      ...basePayload,
      sessionId: stringField(input, "sessionId"),
      episodeId: stringField(input, "episodeId"),
      stats: {
        hits,
        latencyMs: log.durationMs,
      },
    };
  }
  return {
    ...basePayload,
    policyId: stringField(output, "policyId") ?? stringField(input, "policyId"),
    worldModelId: stringField(output, "worldModelId") ?? stringField(input, "worldModelId"),
    skillId: stringField(output, "skillId") ?? stringField(input, "skillId"),
    episodeId: stringField(output, "episodeId") ?? stringField(input, "episodeId"),
    signature: stringField(output, "title") ?? stringField(input, "title"),
  };
}

function hasRetrievalHits(output: Record<string, unknown>): boolean {
  return retrievalHitCount(output) > 0;
}

function retrievalHitCount(output: Record<string, unknown>): number {
  const filtered = Array.isArray(output.filtered) ? output.filtered.length : 0;
  const candidates = Array.isArray(output.candidates) ? output.candidates.length : 0;
  return filtered || candidates;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
