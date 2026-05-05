/**
 * `createMemoryCore` — the adapter-facing façade.
 *
 * The pipeline (see `orchestrator.ts`) owns every algorithm subscriber,
 * every event bus, every runner; it is intentionally richer than the
 * adapter contract. Adapters should never reach into that shape.
 *
 * This file implements the `MemoryCore` interface (see
 * `agent-contract/memory-core.ts`) on top of a `PipelineHandle`:
 *
 *   • Translates JSON-friendly DTOs ↔ core rows.
 *   • Serializes lifecycle transitions (`init` → `shutdown`).
 *   • Maps every error to a stable `MemosError` code so bridges
 *     (JSON-RPC or TCP) can surface them cleanly.
 *
 * Two constructors are exposed:
 *
 *   • `createMemoryCore(handle, home, pkgVersion)` — wrap an already-built
 *     `PipelineHandle`. Keeps the façade trivially mockable in tests.
 *
 *   • `bootstrapMemoryCore(options)` — opens storage, runs migrations,
 *     loads providers + config, and constructs the pipeline from a
 *     minimal `{ agent, home?, config? }` input. Used by adapters.
 */

import { randomUUID } from "node:crypto";

import { MemosError } from "../../agent-contract/errors.js";
import type {
  AgentKind,
  ApiLogDTO,
  EpisodeId,
  EpisodeListItemDTO,
  FeedbackDTO,
  PolicyDTO,
  RetrievalHitDTO,
  RetrievalQueryDTO,
  RetrievalResultDTO,
  SessionId,
  SkillDTO,
  SkillId,
  SubagentOutcomeDTO,
  TraceDTO,
  WorldModelDTO,
} from "../../agent-contract/dto.js";
import type { CoreEvent } from "../../agent-contract/events.js";
import type { LogRecord } from "../../agent-contract/log-record.js";
import type {
  CoreHealth,
  MemoryCore,
  Unsubscribe,
} from "../../agent-contract/memory-core.js";
import type {
  EpisodeSnapshot,
  EpisodeTurn,
  IntentDecision,
} from "../session/types.js";

import type {
  EpisodeRow,
  FeedbackRow,
  PolicyId,
  PolicyRow,
  SkillRow,
  TraceId,
  TraceRow,
  WorldModelId,
  WorldModelRow,
} from "../types.js";
import type { ResolvedConfig, ResolvedHome } from "../config/index.js";
import { loadConfig, resolveHome, SECRET_FIELD_PATHS } from "../config/index.js";
import { rootLogger } from "../logger/index.js";
import type { Logger } from "../logger/types.js";
import { openDb } from "../storage/connection.js";
import { runMigrations } from "../storage/migrator.js";
import { makeRepos } from "../storage/repos/index.js";
import { createEmbedder } from "../embedding/embedder.js";
import { createLlmClient } from "../llm/client.js";
import {
  getHostLlmBridge,
  registerHostLlmBridge,
  type HostLlmBridge,
} from "../llm/host-bridge.js";

import { createPipeline } from "./orchestrator.js";
import type { PipelineDeps, PipelineHandle } from "./types.js";

// ─── Public bootstrap helpers ───────────────────────────────────────────────

export interface BootstrapOptions {
  agent: AgentKind;
  /** Optional pre-resolved home. If omitted, derived from `resolveHome`. */
  home?: ResolvedHome;
  /** Optional pre-resolved config. If omitted, we load from disk. */
  config?: ResolvedConfig;
  /** Override `Date.now` — useful for deterministic tests. */
  now?: () => number;
  /** Plugin package version (surfaced via `health()`). */
  pkgVersion?: string;
  /**
   * Optional adapter-supplied LLM bridge. When set, registered on the
   * shared host-bridge singleton **before** the LLM clients are
   * created so `shouldFallback()` can see it on the very first call.
   *
   * Wiring this through bootstrap (rather than asking the adapter to
   * call `registerHostLlmBridge` itself) avoids a subtle ESM module-
   * identity bug: when the adapter dynamically imports
   * `core/llm/host-bridge.ts` from a different URL than the static
   * `import` chain inside `core/llm/client.ts`, Node's module loader
   * treats them as two separate modules with two independent
   * `currentBridge` slots — register hits one, get sees the other,
   * fallback never engages. Routing through bootstrap forces the
   * register call to happen via the same module instance the LLM
   * client closes over.
   */
  hostLlmBridge?: HostLlmBridge | null;
}

export interface BootstrapResult {
  core: MemoryCore;
  home: ResolvedHome;
  config: ResolvedConfig;
}

/**
 * Build a `MemoryCore` from the ground up. Opens SQLite, runs migrations,
 * constructs the LLM/embedder (if configured) and wires the pipeline.
 *
 * The returned core is **already initialized** — `init()` is a no-op after
 * bootstrapping; callers can still await it if they want the stable contract.
 *
 * Adapters should prefer {@link bootstrapPlugin} instead — it additionally
 * starts the HTTP viewer on the configured port and returns a shutdown
 * handle that tears both down together.
 */
export async function bootstrapMemoryCore(
  options: BootstrapOptions,
): Promise<MemoryCore> {
  const result = await bootstrapMemoryCoreFull(options);
  return result.core;
}

export async function bootstrapMemoryCoreFull(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const home = options.home ?? resolveHome(options.agent);
  const config =
    options.config ??
    (await loadConfig(home)).config;

  const log = rootLogger.child({
    channel: "core.pipeline.bootstrap",
    ctx: { agent: options.agent },
  });

  // 1. Storage.
  const db = openDb({ filepath: home.dbFile, agent: options.agent });
  try {
    runMigrations(db);
  } catch (err) {
    // Migrations are idempotent — a failure here is unrecoverable.
    try {
      db.close();
    } catch {
      /* swallow */
    }
    throw new MemosError(
      "config_invalid",
      `migrations failed for ${home.dbFile}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const repos = makeRepos(db);

  // ─── Host LLM bridge ──
  // Register the adapter-supplied bridge BEFORE constructing any
  // LlmClient so the very first call site sees a non-null bridge.
  // The shouldFallback() check inside the LLM facade reads this
  // singleton at every call; pinning it here guarantees the
  // identity-by-module is the same instance the client closes over.
  if (options.hostLlmBridge) {
    registerHostLlmBridge(options.hostLlmBridge);
    log.info("hostLlmBridge.registered", {
      id: options.hostLlmBridge.id,
    });
  }

  // ─── system_error sink ──
  // Every facade we build (embedder / main LLM / reflect LLM) gets a
  // tiny error sink that drops a `system_error` row into `api_logs`
  // when the underlying provider call fails terminally. The Logs
  // viewer renders these under the "系统" tag so users can correlate
  // a red model card on the Overview with the exact provider message.
  // Wrapped in try/catch because logging must never break the call.
  function recordSystemError(
    role: "embedding" | "llm" | "skillEvolver",
    detail: {
      provider: string;
      model: string;
      message: string;
      code?: string;
      at?: number;
    },
  ): void {
    try {
      repos.apiLogs.insert({
        toolName: "system_error",
        input: { role },
        output: { role, ...detail },
        durationMs: 0,
        success: false,
        calledAt: detail.at ?? Date.now(),
      });
    } catch {
      /* the system_error row itself failing is non-fatal */
    }
  }

  function recordSystemModelStatus(
    role: "embedding" | "llm" | "skillEvolver",
    detail: {
      status: "ok" | "fallback" | "error";
      provider: string;
      model: string;
      message?: string;
      code?: string;
      at?: number;
      durationMs?: number;
      fallbackProvider?: string;
      fallbackModel?: string;
      op?: string;
      episodeId?: string;
      phase?: string;
    },
  ): void {
    try {
      repos.apiLogs.insert({
        toolName: "system_model_status",
        input: {
          role,
          op: detail.op,
          episodeId: detail.episodeId,
          phase: detail.phase,
        },
        output: { role, ...detail },
        durationMs: detail.durationMs ?? 0,
        success: detail.status !== "error",
        calledAt: detail.at ?? Date.now(),
      });
    } catch {
      /* the status row itself failing is non-fatal */
    }
  }

  // 2. Providers (embedding + LLM) — nullable so we can run without them.
  // The LLM facade we build falls through to "local_only" when no remote
  // endpoint is configured, but we still catch construction errors so the
  // core boots headless when providers can't be reached at startup.
  let embedder = null as ReturnType<typeof createEmbedder> | null;
  let llm = null as ReturnType<typeof createLlmClient> | null;
  try {
    embedder = createEmbedder({
      ...(config.embedding as object),
      onError: (d: { provider: string; model: string; message: string; code?: string; at?: number }) =>
        recordSystemError("embedding", d),
      onStatus: (d: {
        status: "ok" | "error";
        provider: string;
        model: string;
        message?: string;
        code?: string;
        at?: number;
        durationMs?: number;
        op?: string;
        episodeId?: string;
        phase?: string;
      }) => recordSystemModelStatus("embedding", d),
    } as never);
  } catch (err) {
    log.warn("embedder.unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    embedder = null;
  }
  try {
    llm = createLlmClient({
      ...(config.llm as object),
      onError: (d: { provider: string; model: string; message: string; code?: string; at?: number }) =>
        recordSystemError("llm", d),
      onStatus: (d: {
        status: "ok" | "fallback" | "error";
        provider: string;
        model: string;
        message?: string;
        code?: string;
        at?: number;
        durationMs?: number;
        fallbackProvider?: string;
        fallbackModel?: string;
        op?: string;
        episodeId?: string;
        phase?: string;
      }) => recordSystemModelStatus("llm", d),
    } as never);
  } catch (err) {
    log.warn("llm.unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    llm = null;
  }

  // When provider=host, the LLM client was created successfully but
  // every call will fail at runtime if no HostLlmBridge is registered.
  // Detect this eagerly and null-out the client so downstream modules
  // see "no LLM" instead of burning retries on every reward/L2/skill
  // tick. The adapter is responsible for calling registerHostLlmBridge()
  // before core.init(); if it hasn't by now, it won't.
  if (llm && llm.provider === "host" && !getHostLlmBridge()) {
    log.warn("llm.host_bridge_missing", {
      provider: "host",
      impact: "LLM client created but no HostLlmBridge registered — " +
        "every call would fail with LLM_UNAVAILABLE. " +
        "Nulling out the client so reward/L2/skill/L3 skip cleanly. " +
        "Configure a direct provider (openai_compatible, anthropic, gemini) " +
        "or ensure the host adapter calls registerHostLlmBridge().",
    });
    llm = null;
  }

  // Build a dedicated LLM for the reflection phase from skillEvolver
  // config when the user has configured a stronger model there. Falls
  // back to the main `llm` when skillEvolver.model is blank.
  let reflectLlm: ReturnType<typeof createLlmClient> | null = null;
  try {
    const evolver = (config as { skillEvolver?: { provider?: string; model?: string; endpoint?: string; apiKey?: string; temperature?: number; timeoutMs?: number } }).skillEvolver;
    const evolverModel = (evolver?.model ?? "").trim();
    const evolverProvider = (evolver?.provider ?? "").trim();
    if (evolverModel && evolverProvider) {
      reflectLlm = createLlmClient({
        provider: evolverProvider,
        model: evolverModel,
        endpoint: evolver?.endpoint ?? "",
        apiKey: evolver?.apiKey ?? "",
        temperature: evolver?.temperature ?? 0,
        timeoutMs: evolver?.timeoutMs ?? 60_000,
        maxRetries: 3,
        // V7 §0.x — when the user's dedicated skill-evolver model is
        // down (auth, model name typo, server outage), prefer falling
        // back to the host agent's main LLM via the stdio host
        // bridge instead of hard-failing the skill pipeline. The
        // viewer paints the slot yellow + surfaces the upstream error
        // so the operator still notices.
        fallbackToHost: true,
        onError: (d: { provider: string; model: string; message: string; code?: string; at?: number }) =>
          recordSystemError("skillEvolver", d),
        onStatus: (d: {
          status: "ok" | "fallback" | "error";
          provider: string;
          model: string;
          message?: string;
          code?: string;
          at?: number;
          durationMs?: number;
          fallbackProvider?: string;
          fallbackModel?: string;
          op?: string;
          episodeId?: string;
          phase?: string;
        }) => recordSystemModelStatus("skillEvolver", d),
      } as never);
      log.info("reflectLlm.ready", {
        provider: evolverProvider,
        model: evolverModel,
        source: "skillEvolver",
      });
    }
  } catch (err) {
    log.warn("reflectLlm.unavailable", {
      err: err instanceof Error ? err.message : String(err),
      fallback: "main llm",
    });
  }

  // 3. Pipeline.
  const deps: PipelineDeps = {
    agent: options.agent,
    home,
    config,
    db,
    repos,
    llm,
    reflectLlm: reflectLlm ?? llm,
    embedder,
    log,
    now: options.now,
  };
  const handle = createPipeline(deps);

  const core = createMemoryCore(handle, home, options.pkgVersion ?? "dev", {
    onShutdown: () => {
      try {
        db.close();
      } catch (err) {
        log.warn("sqlite.close.error", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  return { core, home, config };
}

// ─── Facade factory ──────────────────────────────────────────────────────────

export interface CreateMemoryCoreOptions {
  /** Called after the pipeline has shut down. */
  onShutdown?: () => void | Promise<void>;
}

/**
 * Wrap a pre-built `PipelineHandle` with the `MemoryCore` contract.
 *
 * Lifecycle semantics:
 *   • `init()` is idempotent; once called the core accepts turn events.
 *   • `shutdown()` drains the pipeline, fires `onShutdown`, and refuses
 *     subsequent calls with `MemosError("ALREADY_SHUT_DOWN")`.
 */
export function createMemoryCore(
  handle: PipelineHandle,
  home: ResolvedHome,
  pkgVersion: string,
  options: CreateMemoryCoreOptions = {},
): MemoryCore {
  const bootAt = Date.now();
  const log = rootLogger.child({ channel: "core.pipeline.memory-core" });
  let initialized = false;
  let shutDown = false;
  /** Per-episode monotonic step counter for tool outcomes. */
  const toolStepByEpisode = new Map<string, number>();
  const skillStartedAtByPolicy = new Map<string, number>();
  const skillRunDurationBySkill = new Map<string, number>();
  const l2StartedAtByEpisode = new Map<string, number>();
  let l3StartedAt: number | null = null;
  // Most recent episode that triggered an L3 abstraction run. Set by
  // the L2 → L3 hop on `l2.policy.induced` / `l2.policy.updated`,
  // consumed by L3 lifecycle writers below. The L3 subscriber is
  // single-flight so storing one value is sufficient for grouping
  // `world_model_*` rows with the rest of the triggering episode's
  // pipeline activity in the Logs viewer.
  let l3TriggerEpisodeId: string | undefined;

  function ensureLive(): void {
    if (shutDown) {
      throw new MemosError(
        "already_shut_down",
        "memory-core is shut down",
      );
    }
  }

  // ─── Stale topic auto-finalize ──
  // Open topics are allowed to survive clean session closes and process
  // restarts so the next user turn can be classified against them. Once a
  // topic exceeds this hard window, we treat it as ended and run the normal
  // reflect/reward path.
  const STALE_EPISODE_TIMEOUT_MS = Math.max(
    handle.config.algorithm.session.mergeMaxGapMs * 2,
    4 * 60 * 60 * 1000,
  );
  let lastStaleScan = 0;
  let lastDirtyClosedScan = 0;
  async function autoFinalizeStaleTasks(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - lastStaleScan < 30_000) return;
    lastStaleScan = nowMs;
    try {
      const openEpisodes = handle.repos.episodes.list({ status: "open", limit: 200 });
      if (openEpisodes.length === 0) return;
      const stale: Array<EpisodeRow & { meta?: Record<string, unknown> }> = [];
      for (const ep of openEpisodes) {
        const epAge = nowMs - (ep.endedAt ?? ep.startedAt);
        if (epAge > STALE_EPISODE_TIMEOUT_MS) {
          log.info("stale_topic.auto_finalize", {
            episodeId: ep.id,
            sessionId: ep.sessionId,
            ageMs: epAge,
            thresholdMs: STALE_EPISODE_TIMEOUT_MS,
          });
          stale.push(ep);
        }
      }
      if (stale.length > 0) await recoverOpenEpisodesAsSessionEnd(stale);
    } catch (err) {
      log.debug("stale_topic.scan_error", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function autoRescoreDirtyClosedEpisodes(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - lastDirtyClosedScan < 30_000) return;
    lastDirtyClosedScan = nowMs;
    try {
      const dirtyClosed = handle.repos.episodes
        .list({ status: "closed", limit: 500 })
        .filter((ep) => episodeRewardIsDirty(ep));
      if (dirtyClosed.length > 0) {
        await recoverDirtyClosedEpisodes(dirtyClosed);
      }
    } catch (err) {
      log.debug("dirty_closed_reward.scan_error", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Lifecycle ──
  async function init(): Promise<void> {
    if (shutDown) {
      throw new MemosError(
        "already_shut_down",
        "cannot re-init a shut-down memory-core",
      );
    }
    initialized = true;

    // Preserve recent open topics across restarts. A crash or Ctrl+C is
    // not evidence that the topic ended; the next user turn gets routed
    // through relation classification. Only hard-stale open topics are
    // finalized here so the pipeline eventually catches up.
    try {
      const orphans = handle.repos.episodes.list({ status: "open", limit: 500 });
      if (orphans.length > 0) {
        const nowMs = Date.now();
        const stale = orphans.filter(
          (ep) =>
            ep.rTask != null ||
            (ep.traceIds?.length ?? 0) > 0 ||
            nowMs - (ep.endedAt ?? ep.startedAt) > STALE_EPISODE_TIMEOUT_MS,
        );
        const recent = orphans.filter((ep) => !stale.includes(ep));
        for (const ep of recent) {
          handle.repos.episodes.updateMeta(ep.id as EpisodeId, {
            topicState: (ep.meta?.topicState as string | undefined) ?? "interrupted",
            pauseReason: (ep.meta?.pauseReason as string | undefined) ?? "startup_recovered_open_topic",
            recoveredAtStartup: nowMs,
          });
        }
        if (stale.length > 0) {
          await recoverOpenEpisodesAsSessionEnd(stale);
        }
      }
      const dirtyClosed = handle.repos.episodes
        .list({ status: "closed", limit: 500 })
        .filter((ep) => episodeRewardIsDirty(ep));
      if (dirtyClosed.length > 0) {
        await recoverDirtyClosedEpisodes(dirtyClosed);
      }
    } catch (err) {
      log.debug("init.orphan_scan.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Wire `memory_add` into the api_logs table on EVERY turn so the
    // Logs viewer shows per-turn capture activity. `capture.lite.done`
    // fires once per `onTurnEnd` (the per-turn lite capture path);
    // `capture.done` fires once per topic-end reflect+scoring pass.
    // Both write a `memory_add` row but with different `phase` tags so
    // the viewer can distinguish "stored" from "reflected".
    handle.buses.capture.onAny((evt) => {
      if (evt.kind !== "capture.lite.done" && evt.kind !== "capture.done") return;
      try {
        const r = evt.result;
        const phase = evt.kind === "capture.lite.done" ? "lite" : "reflect";
        const storedCount = r.traceIds.length;
        const statsLine =
          `phase=${phase}, stored=${storedCount}` +
          (r.warnings.length > 0 ? `, warnings=${r.warnings.length}` : "");
        const details = r.traces.map((tc) => ({
          role: inferTurnRole(tc),
          action: phase === "lite" ? ("stored" as const) : ("reflected" as const),
          summary: tc.reflection?.text ?? null,
          content: (
            tc.userText ||
            tc.agentText ||
            summarizeToolCalls(tc.toolCalls) ||
            ""
          ).slice(0, 400),
          traceId: tc.traceId,
        }));
        handle.repos.apiLogs.insert({
          toolName: "memory_add",
          input: {
            sessionId: r.sessionId,
            episodeId: r.episodeId,
            turnCount: r.traces.length,
            phase,
          },
          output: {
            phase,
            stats: statsLine,
            stored: storedCount,
            warnings: r.warnings,
            details,
          },
          durationMs: Math.max(0, r.completedAt - r.startedAt),
          success: r.warnings.length === 0,
          calledAt: r.completedAt,
        });
      } catch (err) {
        log.debug("apiLogs.memory_add.skipped", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // ─── Skill lifecycle → api_logs(skill_*) ──────────────────────────
    // Emit structured rows for the Logs page so users can watch skill
    // generation / verification / retirement events with the same JSON
    // detail the memory_search / memory_add cards show. Event shapes
    // vary per kind — we spread the raw event into `output` (with any
    // sensitive fields already redacted upstream) rather than hand-
    // rolling per-kind schemas.
    handle.buses.skill.onAny((evt) => {
      const k = evt.kind;
      if (k === "skill.crystallization.started") {
        skillStartedAtByPolicy.set(evt.policyId, eventTime(evt));
      } else if (k === "skill.crystallized") {
        const durationMs = durationSince(
          skillStartedAtByPolicy.get(evt.policyId),
          eventTime(evt),
          1,
        );
        skillStartedAtByPolicy.delete(evt.policyId);
        skillRunDurationBySkill.set(evt.skillId, durationMs);
        writeApiLog(handle, log, "skill_generate", {
          phase: "done",
          skillId: evt.skillId,
          policyId: evt.policyId,
          episodeId: episodeFromPolicy(handle, evt.policyId),
        }, evt, durationMs, true);
      } else if (k === "skill.rebuilt" || k === "skill.eta.updated" || k === "skill.archived") {
        const skillId = (evt as { skillId?: string }).skillId;
        const durationMs =
          (skillId ? skillRunDurationBySkill.get(skillId) : undefined) ??
          durationSince(eventTime(evt) - 1, eventTime(evt), 1);
        if (k === "skill.rebuilt" && skillId) skillRunDurationBySkill.delete(skillId);
        const policyIdForSkill = (evt as { policyId?: string }).policyId;
        writeApiLog(handle, log, "skill_evolve", {
          kind: k,
          skillId,
          policyId: policyIdForSkill,
          episodeId:
            episodeFromPolicy(handle, policyIdForSkill) ??
            episodeFromSkill(handle, skillId),
        }, evt, durationMs, true);
      } else if (k === "skill.verification.failed" || k === "skill.failed") {
        const policyId = (evt as { policyId?: string }).policyId;
        const skillId = (evt as { skillId?: string }).skillId;
        const durationMs = durationSince(
          policyId ? skillStartedAtByPolicy.get(policyId) : undefined,
          eventTime(evt),
          policyId ? 1 : 0,
        );
        if (policyId) skillStartedAtByPolicy.delete(policyId);
        writeApiLog(handle, log, "skill_generate", {
          phase: "failed",
          kind: k,
          policyId,
          skillId,
          episodeId:
            episodeFromPolicy(handle, policyId) ??
            episodeFromSkill(handle, skillId),
        }, evt, durationMs, false);
      }
    });

    // ─── L2 (经验) lifecycle → api_logs(policy_*) ─────────────────────
    handle.buses.l2.onAny((evt) => {
      const k = evt.kind;
      if (k === "l2.policy.induced") {
        // L2 induction is the canonical L3 trigger; remember the
        // episode so the next L3 run's lifecycle rows can be grouped
        // with the rest of that episode's pipeline activity.
        l3TriggerEpisodeId = evt.episodeId;
        const durationMs = durationSince(l2StartedAtByEpisode.get(evt.episodeId), Date.now(), 1);
        writeApiLog(handle, log, "policy_generate", {
          phase: "induced",
          policyId: evt.policyId,
          title: evt.title,
          episodeId: evt.episodeId,
        }, evt, durationMs, true);
      } else if (k === "l2.policy.updated") {
        if (evt.status === "active") l3TriggerEpisodeId = evt.episodeId;
        const durationMs = durationSince(l2StartedAtByEpisode.get(evt.episodeId), Date.now(), 1);
        writeApiLog(handle, log, "policy_evolve", {
          policyId: evt.policyId,
          status: evt.status,
          episodeId: evt.episodeId,
        }, evt, durationMs, true);
      } else if (k === "l2.failed") {
        const durationMs = durationSince(l2StartedAtByEpisode.get(evt.episodeId), Date.now(), 1);
        l2StartedAtByEpisode.delete(evt.episodeId);
        writeApiLog(handle, log, "policy_generate", {
          phase: "failed",
          episodeId: evt.episodeId,
        }, evt, durationMs, false);
      }
    });

    // ─── L3 (领域认知) lifecycle → api_logs(world_model_*) ────────────
    handle.buses.l3.onAny((evt) => {
      const k = evt.kind;
      if (k === "l3.abstraction.started") {
        l3StartedAt = Date.now();
      } else if (k === "l3.world-model.created") {
        writeApiLog(handle, log, "world_model_generate", {
          phase: "created",
          worldModelId: evt.worldModelId,
          title: evt.title,
          episodeId:
            episodeFromWorldModel(handle, evt.worldModelId) ??
            l3TriggerEpisodeId,
        }, evt, durationSince(l3StartedAt, Date.now(), 1), true);
      } else if (k === "l3.world-model.updated") {
        writeApiLog(handle, log, "world_model_evolve", {
          worldModelId: evt.worldModelId,
          title: evt.title,
          episodeId:
            episodeFromWorldModel(handle, evt.worldModelId) ??
            l3TriggerEpisodeId,
        }, evt, durationSince(l3StartedAt, Date.now(), 1), true);
      } else if (k === "l3.confidence.adjusted") {
        writeApiLog(handle, log, "world_model_evolve", {
          kind: "confidence.adjusted",
          worldModelId: evt.worldModelId,
          episodeId:
            episodeFromWorldModel(handle, evt.worldModelId) ??
            l3TriggerEpisodeId,
        }, evt, durationSince(l3StartedAt, Date.now(), 1), true);
      } else if (k === "l3.failed") {
        writeApiLog(handle, log, "world_model_generate", {
          phase: "failed",
          episodeId: l3TriggerEpisodeId,
        }, evt, durationSince(l3StartedAt, Date.now(), 1), false);
      }
    });

    // ─── Reward / task completion → api_logs(task_done | task_failed) ──
    // The reward pipeline scores each finished episode; that score is
    // what makes a task "completed" (R ≥ 0) or "failed" (R < 0) in the
    // viewer's Tasks panel.
    handle.buses.reward.onAny((evt) => {
      if (evt.kind === "reward.updated") {
        const result = evt.result;
        const ok = result.rHuman >= 0;
        l2StartedAtByEpisode.set(result.episodeId, Date.now());
        writeApiLog(handle, log, ok ? "task_done" : "task_failed", {
          episodeId: result.episodeId,
          sessionId: result.sessionId,
        }, {
          rHuman: result.rHuman,
          source: result.humanScore.source,
          timings: result.timings,
        }, durationSince(result.startedAt, result.completedAt), ok);
      }
    });
  }

  async function recoverOpenEpisodesAsSessionEnd(
    orphans: Array<EpisodeRow & { meta?: Record<string, unknown> }>,
  ): Promise<void> {
    const endedAt = Date.now();
    log.info("init.orphan_episodes.session_end_recover", { count: orphans.length });
    debugStartupRecovery("H1", "startup_recovery_scan", {
      count: orphans.length,
      episodes: orphans.map((ep) => ({
        id: ep.id,
        sessionId: ep.sessionId,
        traceCount: ep.traceIds.length,
        rTask: ep.rTask,
      })),
    });

    const needsRewardFallback: EpisodeId[] = [];
    for (const ep of orphans) {
      try {
        const episodeId = ep.id as EpisodeId;
        const traceIds = (ep.traceIds ?? []) as TraceId[];
        handle.repos.episodes.close(episodeId, endedAt, ep.rTask ?? undefined);
        handle.repos.episodes.updateMeta(episodeId, {
          closeReason: "finalized",
          abandonReason: undefined,
          recoveredAtStartup: endedAt,
          recoveryReason: "missed_session_end",
        });

        if (ep.rTask != null && !episodeRewardIsDirty(ep)) {
          log.info("init.orphan.repaired_finalized", {
            episodeId,
            sessionId: ep.sessionId,
            rTask: ep.rTask,
          });
          debugStartupRecovery("H2", "startup_recovery_already_scored", {
            episodeId,
            sessionId: ep.sessionId,
            rTask: ep.rTask,
          });
          continue;
        }

        const snapshot = snapshotFromRecoveredEpisode(ep, endedAt);
        debugStartupRecovery("H3", "startup_recovery_emit_finalized", {
          episodeId,
          sessionId: ep.sessionId,
          traceCount: traceIds.length,
          recoveredTurnCount: snapshot.turnCount,
        });
        handle.buses.session.emit({
          kind: "episode.finalized",
          episode: snapshot,
          closedBy: "finalized",
        });
        needsRewardFallback.push(episodeId);
      } catch (err) {
        log.debug("init.orphan_recovery.skipped", {
          episodeId: ep.id,
          err: err instanceof Error ? err.message : String(err),
        });
        debugStartupRecovery("H4", "startup_recovery_error", {
          episodeId: ep.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      await handle.flush();
      for (const episodeId of needsRewardFallback) {
        const row = handle.repos.episodes.getById(episodeId);
        if (row?.rTask == null) {
          await handle.rewardRunner.run({
            episodeId,
            feedback: [],
            trigger: "manual",
          });
        }
      }
      await handle.flush();
      debugStartupRecovery("H5", "startup_recovery_flush_done", {
        recoveredCount: orphans.length,
        rewardedEpisodes: needsRewardFallback.map((episodeId) => {
          const row = handle.repos.episodes.getById(episodeId);
          return {
            episodeId,
            rTask: row?.rTask ?? null,
            closeReason: (row?.meta as { closeReason?: unknown } | undefined)?.closeReason,
            abandonReason: (row?.meta as { abandonReason?: unknown } | undefined)?.abandonReason,
          };
        }),
      });
    } catch (err) {
      log.warn("init.orphan_recovery.flush_failed", {
        count: orphans.length,
        err: err instanceof Error ? err.message : String(err),
      });
      debugStartupRecovery("H5", "startup_recovery_flush_failed", {
        count: orphans.length,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function recoverDirtyClosedEpisodes(
    episodes: Array<EpisodeRow & { meta?: Record<string, unknown> }>,
  ): Promise<void> {
    log.info("init.dirty_closed_episodes.rescore", { count: episodes.length });
    for (const ep of episodes) {
      const episodeId = ep.id as EpisodeId;
      const endedAt = ep.endedAt ?? Date.now();
      handle.repos.episodes.updateMeta(episodeId, {
        closeReason: "finalized",
        recoveredAtStartup: endedAt,
        recoveryReason: "dirty_reward_rescore",
      });
      const snapshot = snapshotFromRecoveredEpisode(ep, endedAt, {
        recoveryReason: "dirty_reward_rescore",
      });
      handle.buses.session.emit({
        kind: "episode.finalized",
        episode: snapshot,
        closedBy: "finalized",
      });
    }
    await handle.flush();
  }

  function episodeRewardIsDirty(ep: EpisodeRow & { meta?: Record<string, unknown> }): boolean {
    const meta = ep.meta ?? {};
    if (meta.rewardDirty && typeof meta.rewardDirty === "object") return true;

    const reward = meta.reward;
    if (reward && typeof reward === "object" && (reward as { skipped?: unknown }).skipped === true) {
      return false;
    }
    if (
      ep.rTask == null &&
      (ep.traceIds?.length ?? 0) > 0 &&
      (meta.closeReason === "finalized" || meta.recoveryReason === "missed_session_end")
    ) {
      return true;
    }
    if (!reward || typeof reward !== "object") return false;
    const traceCount = (reward as { traceCount?: unknown }).traceCount;
    if (typeof traceCount === "number") {
      return traceCount !== (ep.traceIds?.length ?? 0);
    }

    // Backward compatibility for episodes scored before reward coverage
    // metadata existed: if a trace was appended after the recorded reward
    // time, the old task score no longer covers the full episode.
    const scoredAt = (reward as { scoredAt?: unknown }).scoredAt;
    if (typeof scoredAt !== "number") return false;
    const traceIds = (ep.traceIds ?? []) as TraceId[];
    if (traceIds.length === 0) return false;
    return handle.repos.traces
      .getManyByIds(traceIds)
      .some((tr) => tr.ts > scoredAt);
  }

  function snapshotFromRecoveredEpisode(
    ep: EpisodeRow & { meta?: Record<string, unknown> },
    endedAt: number,
    opts: { recoveryReason?: string } = {},
  ): EpisodeSnapshot {
    const traceIds = (ep.traceIds ?? []) as TraceId[];
    const traces =
      traceIds.length > 0
        ? handle.repos.traces
            .getManyByIds(traceIds)
            .sort((a, b) => a.ts - b.ts)
        : [];
    const turns: EpisodeTurn[] = [];
    for (const tr of traces) {
      if (tr.userText) {
        turns.push({
          id: `${tr.id}:user`,
          ts: tr.ts,
          role: "user",
          content: tr.userText,
        });
      }
      if (tr.toolCalls.length > 0) {
        turns.push({
          id: `${tr.id}:tool`,
          ts: tr.ts,
          role: "tool",
          content: JSON.stringify(tr.toolCalls),
          meta: { toolCalls: tr.toolCalls },
        });
      }
      if (tr.agentText) {
        turns.push({
          id: `${tr.id}:assistant`,
          ts: tr.ts,
          role: "assistant",
          content: tr.agentText,
          meta: {
            thinking: tr.agentThinking ?? undefined,
            summary: tr.summary ?? undefined,
          },
        });
      }
    }
    return {
      id: ep.id as EpisodeId,
      sessionId: ep.sessionId as SessionId,
      startedAt: ep.startedAt,
      endedAt,
      status: "closed",
      rTask: ep.rTask ?? null,
      turnCount: turns.length,
      turns,
      traceIds,
      meta: {
        ...(ep.meta ?? {}),
        closeReason: "finalized",
        recoveredAtStartup: endedAt,
        recoveryReason: opts.recoveryReason ?? "missed_session_end",
      },
      intent: normaliseRecoveredIntent(ep.meta),
    };
  }

  function normaliseRecoveredIntent(meta?: Record<string, unknown>): IntentDecision {
    const maybeIntent = (meta as { intent?: Partial<IntentDecision> } | undefined)?.intent;
    return {
      kind: maybeIntent?.kind ?? "unknown",
      confidence: typeof maybeIntent?.confidence === "number" ? maybeIntent.confidence : 0,
      reason: maybeIntent?.reason ?? "recovered from startup orphan episode",
      retrieval: maybeIntent?.retrieval ?? {
        tier1: true,
        tier2: true,
        tier3: true,
      },
      llmModel: maybeIntent?.llmModel,
      signals: maybeIntent?.signals ?? ["startup_recovery"],
    };
  }

  function debugStartupRecovery(
    hypothesisId: string,
    message: string,
    data: Record<string, unknown>,
  ): void {}

  async function shutdown(): Promise<void> {
    if (shutDown) return;
    shutDown = true;
    try {
      await handle.shutdown("memory-core.shutdown");
    } finally {
      if (options.onShutdown) {
        await options.onShutdown();
      }
    }
  }

  async function health(): Promise<CoreHealth> {
    // Read the latest on-disk config so that model names reflect what
    // the user last saved, even before a restart applies the change.
    let diskConfig: ResolvedConfig | null = null;
    try {
      const { loadConfig } = await import("../config/index.js");
      const { config } = await loadConfig(handle.home);
      diskConfig = config;
    } catch {
      /* fall through to in-memory */
    }

    const llmInfo = llmHealth(handle.llm, latestTraceTs());
    const embedderInfo = embedderHealth(handle.embedder, latestTraceTs());
    const skillEvolverInfo = resolveSkillEvolver(
      diskConfig ?? handle.config,
      // Prefer the dedicated reflect LLM stats so an independently
      // configured skill-evolver model reports its OWN failures
      // instead of inheriting the (possibly healthy) summary LLM's
      // status. Falls back to `handle.llm` when the operator left
      // skillEvolver blank — bootstrap aliases reflectLlm to llm
      // in that case anyway.
      handle.reflectLlm ?? handle.llm,
      latestTraceTs(),
    );

    // NOTE: we deliberately do NOT fall back to `api_logs`-stored
    // historical `system_error` rows here. Doing so used to keep the
    // overview card red across restarts even after the operator had
    // already fixed the misconfigured endpoint, because the ancient
    // failure row would mask a freshly-booted process whose stats
    // are still null. Now the card colour is driven purely by
    // in-memory stats — if you want to inspect past failures, head
    // to LogsView → 系统 tag.

    // Override model names from disk config if they differ from the
    // in-memory client (user saved new settings but hasn't restarted).
    if (diskConfig) {
      const diskLlm = diskConfig.llm as { model?: string; provider?: string } | undefined;
      if (diskLlm?.model && diskLlm.model !== llmInfo.model) {
        llmInfo.model = diskLlm.model;
        if (diskLlm.provider) llmInfo.provider = diskLlm.provider;
      }
      const diskEmb = diskConfig.embedding as { model?: string; provider?: string } | undefined;
      if (diskEmb?.model && diskEmb.model !== embedderInfo.model) {
        embedderInfo.model = diskEmb.model;
        if (diskEmb.provider) embedderInfo.provider = diskEmb.provider;
      }
    }

    applyPersistedModelStatus(handle.repos, "llm", llmInfo);
    applyPersistedModelStatus(handle.repos, "embedding", embedderInfo);
    applyPersistedModelStatus(
      handle.repos,
      skillEvolverInfo.inherited ? "llm" : "skillEvolver",
      skillEvolverInfo,
    );

    return {
      ok: initialized && !shutDown,
      version: pkgVersion,
      uptimeMs: Date.now() - bootAt,
      agent: handle.agent,
      paths: {
        home: home.root,
        config: home.configFile,
        db: home.dbFile,
        skills: home.skillsDir,
        logs: home.logsDir,
      },
      llm: llmInfo,
      embedder: embedderInfo,
      skillEvolver: skillEvolverInfo,
    };
  }

  function latestTraceTs(): number | null {
    try {
      const rows = handle.repos.traces.list({ limit: 1 });
      if (rows.length === 0) return null;
      return rows[0]?.ts ?? null;
    } catch {
      return null;
    }
  }

  // ─── Session / episode ──
  async function openSession(input: {
    agent: AgentKind;
    sessionId?: SessionId;
    meta?: Record<string, unknown>;
  }): Promise<SessionId> {
    ensureLive();
    const snap = handle.sessionManager.openSession({
      id: input.sessionId,
      agent: input.agent,
      meta: input.meta ?? {},
    });
    return snap.id as SessionId;
  }

  async function closeSession(sessionId: SessionId): Promise<void> {
    ensureLive();
    const existing = handle.sessionManager.getSession(sessionId);
    if (!existing) {
      throw new MemosError(
        "session_not_found",
        `session not found: ${sessionId}`,
      );
    }
    handle.sessionManager.closeSession(sessionId, "client");
    try {
      await handle.flush();
    } catch (err) {
      log.warn("closeSession.flush_failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function openEpisode(input: {
    sessionId: SessionId;
    episodeId?: EpisodeId;
    /**
     * Optional initial user text — when an adapter opens an episode
     * eagerly (outside the normal `onTurnStart` flow) it may not have
     * the user's message yet. Pass it when you do; otherwise the core
     * uses a placeholder so the downstream `episode-manager.start`
     * invariant holds.
     */
    userMessage?: string;
  }): Promise<EpisodeId> {
    ensureLive();
    const snap = await handle.sessionManager.startEpisode({
      sessionId: input.sessionId,
      userMessage: input.userMessage?.trim() || "(adapter-initiated)",
      meta: input.episodeId ? { adapterSuppliedId: input.episodeId } : {},
    });
    return snap.id as EpisodeId;
  }

  async function closeEpisode(episodeId: EpisodeId): Promise<void> {
    ensureLive();
    const snap = handle.sessionManager.getEpisode(episodeId);
    if (!snap) {
      throw new MemosError(
        "episode_not_found",
        `episode not found: ${episodeId}`,
      );
    }
    if (snap.status === "closed") return;
    handle.sessionManager.finalizeEpisode(episodeId);
    // For adapters whose process exits right after `episode.close`
    // (e.g. Hermes' single-shot `hermes chat -q ...` mode), the
    // background reflect → reward → L2 / L3 / Skill chain wouldn't
    // get a chance to run before the process is reaped. Block the RPC
    // here so the caller can be sure the full chain has flushed by
    // the time `episode.close` returns. The cost is a few seconds of
    // extra latency on the close call — but the chat is already done
    // at this point, so the user doesn't wait on it.
    try {
      await handle.flush();
    } catch (err) {
      log.warn("closeEpisode.flush_failed", {
        episodeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Pipeline (per turn) ──
  async function onTurnStart(
    turn: Parameters<MemoryCore["onTurnStart"]>[0],
  ): Promise<RetrievalResultDTO> {
    ensureLive();
    const startedAt = Date.now();
    let ok = true;
    let packet: Awaited<ReturnType<typeof handle.onTurnStart>> | null = null;
    try {
      packet = await handle.onTurnStart(turn);

      // The orchestrator stamps the *routed* session / episode id onto the
      // packet (V7 §0.1 may create, reopen, or migrate to a new session),
      // so we surface those back to the caller. Adapters correlate
      // `onTurnEnd` to the same ids via `query.sessionId` /
      // `query.episodeId`, instead of having to keep their own cache.
      const query: RetrievalQueryDTO = {
        agent: turn.agent,
        sessionId: packet.sessionId,
        episodeId: packet.episodeId,
        query: turn.userText,
      };
      const hits: RetrievalHitDTO[] = packet.snippets.map((snip) => {
        const tier: 1 | 2 | 3 = inferTier(snip.refKind);
        return {
          tier,
          refId: snip.refId,
          refKind:
            snip.refKind === "preference" || snip.refKind === "anti-pattern"
              ? "trace"
              : snip.refKind,
          score: snip.score ?? 0,
          snippet: snip.body,
        };
      });
      return {
        query,
        hits,
        injectedContext: packet.rendered,
        tierLatencyMs: packet.tierLatencyMs,
      };
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      // Log every retrieval — not just adhoc `searchMemory` calls —
      // so the viewer's Logs page can show what was recalled for
      // each real agent turn. Without this, `memory_search` rows
      // only showed up when the viewer's search box was used.
      try {
        const snippets = packet?.snippets ?? [];
        const candidates = snippets.map((s) => ({
          tier: inferTier(s.refKind),
          refKind: s.refKind,
          refId: s.refId,
          score: s.score ?? 0,
          snippet: s.body,
        }));
        const droppedIds = new Set(
          (packet?.droppedByLlm ?? []).map((s) => s.refId as string),
        );
        const filtered = candidates.filter((c) => !droppedIds.has(c.refId));
        const dropped = candidates.filter((c) => droppedIds.has(c.refId));
        const stats = packet ? handle.consumeRetrievalStats(packet.packetId) : null;
        handle.repos.apiLogs.insert({
          toolName: "memory_search",
          input: {
            type: "turn_start",
            agent: turn.agent,
            query: turn.userText.slice(0, 2_000),
            sessionId: packet?.sessionId ?? turn.sessionId ?? null,
            episodeId: packet?.episodeId ?? turn.episodeId ?? null,
          },
          output: ok
            ? {
                candidates,
                hubCandidates: [] as unknown[],
                filtered,
                droppedByLlm: dropped,
                stats: stats ? retrievalStatsPayload(stats) : undefined,
              }
            : { error: "turn_start_retrieval_failed" },
          durationMs: Date.now() - startedAt,
          success: ok,
          calledAt: startedAt,
        });
      } catch (logErr) {
        log.debug("apiLogs.memory_search.turn_start.skipped", {
          err: logErr instanceof Error ? logErr.message : String(logErr),
        });
      }
    }
  }

  async function onTurnEnd(
    result: Parameters<MemoryCore["onTurnEnd"]>[0],
  ): Promise<{ traceId: string; episodeId: EpisodeId }> {
    ensureLive();
    const outcome = await handle.onTurnEnd(result);
    // Return the real row id produced by the synchronous lite capture.
    // Feedback submits this id as a FK, so a synthetic placeholder would
    // cause SQLite "FOREIGN KEY constraint failed" later.
    const traceIds = outcome.traceIds.length > 0
      ? outcome.traceIds
      : outcome.episode?.traceIds ?? [];
    const lastTraceId = traceIds[traceIds.length - 1] ?? "";
    return {
      traceId: lastTraceId,
      episodeId: outcome.episodeId,
    };
  }

  async function submitFeedback(
    feedback: Omit<FeedbackDTO, "id" | "ts"> & { ts?: number },
  ): Promise<FeedbackDTO> {
    ensureLive();
    if (feedback.traceId && !handle.repos.traces.getById(feedback.traceId as TraceId)) {
      throw new MemosError(
        "trace_not_found",
        `trace not found: ${feedback.traceId}`,
        { traceId: feedback.traceId },
      );
    }
    const ts = feedback.ts ?? Date.now();
    const id = randomUUID();
    const row: FeedbackRow = {
      id,
      ts,
      episodeId: feedback.episodeId ?? null,
      traceId: feedback.traceId ?? null,
      channel: feedback.channel,
      polarity: feedback.polarity,
      magnitude: feedback.magnitude,
      rationale: feedback.rationale ?? null,
      raw: feedback.raw ?? null,
    };
    handle.repos.feedback.insert(row);

    // Push the human signal into the reward loop via the capture bus.
    // The feedback subscriber also listens for user feedback via its
    // own input channel, but for the JSON-RPC path we go through the
    // repository so every code path persists.
    return toFeedbackDTO(row);
  }

  function recordToolOutcome(outcome: {
    sessionId: SessionId;
    episodeId?: EpisodeId;
    tool: string;
    success: boolean;
    errorCode?: string;
    durationMs: number;
    ts: number;
  }): void {
    if (shutDown) return;
    const key = outcome.episodeId ?? outcome.sessionId;
    const step = (toolStepByEpisode.get(key) ?? 0) + 1;
    toolStepByEpisode.set(key, step);
    try {
      handle.recordToolOutcome({
        sessionId: outcome.sessionId,
        episodeId: outcome.episodeId,
        tool: outcome.tool,
        step,
        success: outcome.success,
        errorCode: outcome.errorCode,
        context: outcome.sessionId,
        ts: outcome.ts,
      });
    } catch (err) {
      log.warn("memory-core.record_tool_outcome.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function recordSubagentOutcome(
    outcome: SubagentOutcomeDTO,
  ): Promise<{ traceId: string; episodeId: EpisodeId }> {
    ensureLive();
    const ts = outcome.ts ?? Date.now();
    const task = outcome.task.trim() || "(subagent task)";
    const result = outcome.result.trim() || outcome.error || outcome.outcome || "(no subagent result)";
    const normalizedOutcome = outcome.outcome ?? (outcome.error ? "error" : "unknown");
    const childToolCalls = outcome.toolCalls ?? [];

    await openSession({ agent: outcome.agent, sessionId: outcome.sessionId });
    const recorded = await onTurnEnd({
      agent: outcome.agent,
      sessionId: outcome.sessionId,
      episodeId: outcome.episodeId ?? ("" as EpisodeId),
      agentText: `Subagent task: ${task}\n\nSubagent result: ${result}`,
      toolCalls: [
        {
          name: "subagent",
          input: {
            task,
            childSessionId: outcome.childSessionId ?? null,
            childToolCalls: childToolCalls.length,
            outcome: normalizedOutcome,
            meta: outcome.meta ?? {},
          },
          output: {
            result,
            error: outcome.error ?? null,
          },
          errorCode:
            outcome.error || (normalizedOutcome !== "ok" && normalizedOutcome !== "unknown")
              ? normalizedOutcome
              : undefined,
          startedAt: ts,
          endedAt: ts,
        },
      ],
      ts,
    });
    const anchor = {
      task,
      result,
      childSessionId: outcome.childSessionId ?? null,
      traceId: recorded.traceId as TraceId,
      meta: outcome.meta ?? {},
    };
    anchorSubagentTraceAfterDelegate(recorded.episodeId, anchor);

    let childRecorded: { traceId: string; episodeId: EpisodeId } | null = null;
    const childSessionId = outcome.childSessionId ?? null;
    if (childSessionId && childSessionId !== outcome.sessionId) {
      const childHasEpisode = handle.repos.episodes
        .list({ sessionId: childSessionId, limit: 1 })
        .length > 0;
      if (!childHasEpisode) {
        try {
          await openSession({ agent: outcome.agent, sessionId: childSessionId });
          const childTurn = await onTurnStart({
            agent: outcome.agent,
            sessionId: childSessionId,
            userText: `Subagent task: ${task}`,
            ts,
          });
          const childEpisodeId = childTurn.query.episodeId;
          if (!childEpisodeId) {
            throw new Error("child turn.start did not return an episodeId");
          }
          childRecorded = await onTurnEnd({
            agent: outcome.agent,
            sessionId: childSessionId,
            episodeId: childEpisodeId,
            agentText: `Subagent result: ${result}`,
            toolCalls: childToolCalls,
            ts: ts + 1,
          });
          await closeEpisode(childEpisodeId);
        } catch (err) {
          log.warn("subagent.child_episode.create_failed", {
            childSessionId,
            parentSessionId: outcome.sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    anchorSubagentTraceAfterDelegate(recorded.episodeId, anchor);

    try {
      handle.repos.apiLogs.insert({
        toolName: "subagent_record",
        input: {
          agent: outcome.agent,
          sessionId: outcome.sessionId,
          episodeId: outcome.episodeId ?? null,
          childSessionId: outcome.childSessionId ?? null,
          task,
          childToolCalls: childToolCalls.length,
          outcome: normalizedOutcome,
          meta: outcome.meta ?? {},
        },
        output: {
          result,
          error: outcome.error ?? null,
          traceId: recorded.traceId,
          episodeId: recorded.episodeId,
          childTraceId: childRecorded?.traceId ?? null,
          childEpisodeId: childRecorded?.episodeId ?? null,
        },
        durationMs: 0,
        success: !outcome.error && normalizedOutcome !== "error",
        calledAt: ts,
      });
    } catch (err) {
      log.debug("apiLogs.subagent_record.skipped", {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return recorded;
  }

  function anchorSubagentTraceAfterDelegate(
    episodeId: EpisodeId,
    anchor: {
      task: string;
      result: string;
      childSessionId: SessionId | null;
      traceId: TraceId;
      meta: Record<string, unknown>;
    },
  ): void {
    const episode = handle.repos.episodes.getById(episodeId);
    if (!episode) return;
    const rows = episode.traceIds.length > 0
      ? handle.repos.traces.getManyByIds(episode.traceIds)
      : handle.repos.traces.list({ episodeId, limit: 500, newestFirst: false });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = (
      episode.traceIds.length > 0 ? episode.traceIds : rows.map((row) => row.id)
    ).filter((id) => byId.has(id));
    const synthetic = ordered.filter((id) =>
      isMatchingSubagentTrace(byId.get(id)!, anchor),
    );
    if (synthetic.length === 0) return;
    const delegateId = findMatchingDelegateTaskTrace(ordered.map((id) => byId.get(id)!), anchor);
    if (!delegateId) return;
    moveUserTextToAnchoredDelegate(byId, delegateId, synthetic);

    const withoutSynthetic = ordered.filter((id) => !synthetic.includes(id));
    const delegateIdx = withoutSynthetic.indexOf(delegateId);
    if (delegateIdx < 0) return;
    const next = [
      ...withoutSynthetic.slice(0, delegateIdx + 1),
      ...synthetic,
      ...withoutSynthetic.slice(delegateIdx + 1),
    ];
    if (next.join("\0") !== episode.traceIds.join("\0")) {
      handle.repos.episodes.appendTrace(episodeId, next);
    }
  }

  function moveUserTextToAnchoredDelegate(
    byId: Map<string, TraceRow>,
    delegateId: TraceId,
    syntheticIds: string[],
  ): void {
    const delegate = byId.get(delegateId);
    if (!delegate || delegate.userText.trim()) return;
    const source = syntheticIds
      .map((id) => byId.get(id))
      .find((row): row is TraceRow =>
        Boolean(row && row.turnId === delegate.turnId && row.userText.trim()),
      );
    if (!source) return;
    handle.repos.traces.updateBody(delegateId, { userText: source.userText });
    handle.repos.traces.updateBody(source.id, { userText: "" });
    delegate.userText = source.userText;
    source.userText = "";
  }

  function isMatchingSubagentTrace(
    row: TraceRow,
    anchor: {
      task: string;
      result: string;
      childSessionId: SessionId | null;
      traceId: TraceId;
      meta: Record<string, unknown>;
    },
  ): boolean {
    if (row.id === anchor.traceId) return true;
    if (row.agentText.includes(`Subagent task: ${anchor.task}`)) return true;
    if (row.agentText.includes(`Subagent result: ${anchor.result}`)) return true;
    const tool = row.toolCalls[0];
    if (!tool || tool.name !== "subagent") return false;
    const input = asRecord(tool.input);
    if (!input) return false;
    if (typeof input.task === "string" && input.task === anchor.task) return true;
    return anchor.childSessionId != null && input.childSessionId === anchor.childSessionId;
  }

  function findMatchingDelegateTaskTrace(
    rows: TraceRow[],
    anchor: { task: string; meta: Record<string, unknown> },
  ): TraceId | null {
    const anchorToolCallId = subagentAnchorToolCallId(anchor.meta);
    if (anchorToolCallId) {
      const byId = rows.find((row) => delegateToolCallIdMatches(row, anchorToolCallId));
      if (byId) return byId.id;
    }

    // Deterministic fallback for Hermes versions whose `on_delegation`
    // hook does not expose tool_call_id: only anchor when exactly one
    // delegate_task goal equals the subagent task.
    const matches = rows.filter((row) => delegateTaskGoal(row) === anchor.task);
    return matches.length === 1 ? matches[0]!.id : null;
  }

  function delegateToolCallIdMatches(row: TraceRow, anchorToolCallId: string): boolean {
    const tool = row.toolCalls[0];
    if (!tool || tool.name !== "delegate_task") return false;
    if (tool.toolCallId === anchorToolCallId) return true;

    const input = parseMaybeJsonObject(tool.input);
    if (!input) return false;
    const inputCallId = firstString(
      input.toolCallId,
      input.tool_call_id,
      input.callId,
      input.call_id,
    );
    return inputCallId === anchorToolCallId;
  }

  function delegateTaskGoal(row: TraceRow): string | null {
    const tool = row.toolCalls[0];
    if (!tool || tool.name !== "delegate_task") return null;
    const input = parseMaybeJsonObject(tool.input);
    if (!input) return null;
    return firstString(input.goal);
  }

  function subagentAnchorToolCallId(meta: Record<string, unknown>): string | null {
    const hookKwargs = asRecord(meta.hookKwargs) ?? {};
    return firstString(
      meta.toolCallId,
      meta.tool_call_id,
      meta.callId,
      meta.call_id,
      hookKwargs.toolCallId,
      hookKwargs.tool_call_id,
      hookKwargs.callId,
      hookKwargs.call_id,
    );
  }

  function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value !== "string") return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  function firstString(...values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  // ─── Memory queries ──
  async function searchMemory(
    query: RetrievalQueryDTO,
  ): Promise<RetrievalResultDTO> {
    ensureLive();
    const deps = handle.retrievalDeps();
    const { turnStartRetrieve } = await import("../retrieval/retrieve.js");
    const sessionId =
      query.sessionId ??
      ("adhoc-session-" + randomUUID().slice(0, 8) as SessionId);
    const ts = Date.now();
    const startedAt = Date.now();
    let ok = true;
    let candidates: Array<{
      tier: number;
      refKind: string;
      refId: string;
      score: number;
      snippet: string;
    }> = [];
    let filtered: typeof candidates = [];
    let retrievalStats: {
      raw?: number;
      ranked?: number;
      droppedByThreshold?: number;
      thresholdFloor?: number;
      topRelevance?: number;
      llmFilter?: {
        outcome?: string;
        kept?: number;
        dropped?: number;
        sufficient?: boolean | null;
      };
      channelHits?: Record<string, number>;
      queryTokens?: number;
      queryTags?: string[];
      embedding?: {
        attempted: boolean;
        ok: boolean;
        degraded: boolean;
        errorCode?: string;
        errorMessage?: string;
      };
    } | undefined;
    try {
      const result = await turnStartRetrieve(deps, {
        reason: "turn_start",
        agent: query.agent,
        sessionId,
        episodeId: query.episodeId,
        userText: query.query,
        contextHints: query.filters ?? {},
        ts,
      });
      const hits: RetrievalHitDTO[] = result.packet.snippets.map((snip) => ({
        tier: inferTier(snip.refKind),
        refId: snip.refId,
        refKind:
          snip.refKind === "preference" || snip.refKind === "anti-pattern"
            ? "trace"
            : snip.refKind,
        score: snip.score ?? 0,
        snippet: snip.body,
      }));
      // Build the logs-page payload BEFORE returning so the row
      // reflects the exact shape the adapter sees. `candidates` lists
      // everything tiered/retrieved; `filtered` is what the injector
      // kept (≤ `maxSnippets`), matching the legacy "LLM filtered"
      // semantics the user complained about.
      candidates = hits.map((h) => ({
        tier: h.tier,
        refKind: h.refKind,
        refId: h.refId,
        score: h.score,
        snippet: h.snippet,
      }));
      filtered = candidates; // post-filter is what we return → same list.

      // Three-stage observability — surfaced verbatim so the viewer's
      // Logs page can render "raw → threshold → ranked → LLM filter"
      // funnels. All fields are optional on the producer side so older
      // consumers keep working.
      const s = result.stats;
      retrievalStats = retrievalStatsPayload(s);
      if (s.embedding?.degraded) {
        handle.repos.apiLogs.insert({
          toolName: "system_error",
          input: { role: "embedding" },
          output: {
            role: "embedding",
            provider: deps.embedder ? "retrieval" : "none",
            model: "query",
            message: s.embedding.errorMessage ?? "query embedding failed; retrieval degraded",
            code: s.embedding.errorCode,
          },
          durationMs: 0,
          success: false,
          calledAt: Date.now(),
        });
      }

      return {
        query,
        hits,
        injectedContext: result.packet.rendered,
        tierLatencyMs: result.packet.tierLatencyMs,
      };
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      try {
        handle.repos.apiLogs.insert({
          toolName: "memory_search",
          input: {
            type: "tool_call",
            agent: query.agent,
            query: query.query,
            sessionId,
            episodeId: query.episodeId ?? null,
            topK: query.topK,
          },
          output: ok
            ? {
                candidates,
                hubCandidates: [] as unknown[],
                filtered,
                stats: retrievalStats,
              }
            : { error: "retrieval_failed" },
          durationMs: Date.now() - startedAt,
          success: ok,
          calledAt: startedAt,
        });
      } catch (logErr) {
        log.debug("apiLogs.memory_search.skipped", {
          err: logErr instanceof Error ? logErr.message : String(logErr),
        });
      }
    }
  }

  async function getTrace(id: string): Promise<TraceDTO | null> {
    ensureLive();
    const row = handle.repos.traces.getById(id);
    return row ? traceRowToDTO(row, handle.repos.episodes.getById(row.episodeId)) : null;
  }

  async function updateTrace(
    id: string,
    patch: {
      summary?: string | null;
      userText?: string;
      agentText?: string;
      tags?: readonly string[];
    },
  ): Promise<TraceDTO | null> {
    ensureLive();
    const existing = handle.repos.traces.getById(id);
    if (!existing) return null;
    handle.repos.traces.updateBody(id, patch);
    const updated = handle.repos.traces.getById(id);
    return updated
      ? traceRowToDTO(updated, handle.repos.episodes.getById(updated.episodeId))
      : null;
  }

  async function deleteTrace(id: string): Promise<{ deleted: boolean }> {
    ensureLive();
    const existing = handle.repos.traces.getById(id);
    if (!existing) return { deleted: false };
    handle.repos.traces.deleteById(id);
    return { deleted: true };
  }

  async function deleteTraces(ids: readonly string[]): Promise<{ deleted: number }> {
    ensureLive();
    let deleted = 0;
    // Process one-by-one so a bad id doesn't poison the whole batch.
    // The viewer's bulk delete is low-frequency (dozens at a time).
    for (const id of ids) {
      const existing = handle.repos.traces.getById(id);
      if (!existing) continue;
      handle.repos.traces.deleteById(id);
      deleted++;
    }
    return { deleted };
  }

  async function shareTrace(
    id: string,
    share: {
      scope: "private" | "public" | "hub" | null;
      target?: string | null;
      sharedAt?: number | null;
    },
  ): Promise<TraceDTO | null> {
    ensureLive();
    const existing = handle.repos.traces.getById(id);
    if (!existing) return null;
    handle.repos.traces.updateShare(id, share);
    const updated = handle.repos.traces.getById(id);
    return updated
      ? traceRowToDTO(updated, handle.repos.episodes.getById(updated.episodeId))
      : null;
  }

  async function getPolicy(id: string): Promise<PolicyDTO | null> {
    ensureLive();
    const row = handle.repos.policies.getById(id);
    return row ? policyRowToDTO(row) : null;
  }

  async function listPolicies(input?: {
    status?: PolicyDTO["status"];
    limit?: number;
    offset?: number;
    q?: string;
  }): Promise<PolicyDTO[]> {
    ensureLive();
    const limit = Math.max(1, Math.min(500, input?.limit ?? 50));
    const offset = Math.max(0, input?.offset ?? 0);
    const needle = (input?.q ?? "").trim().toLowerCase();
    const rows = handle.repos.policies.list({
      status: input?.status,
      limit: limit + offset + (needle ? 200 : 0),
      offset: 0,
    });
    const filtered = needle
      ? rows.filter((r) =>
          (r.title + "\n" + r.trigger + "\n" + r.procedure)
            .toLowerCase()
            .includes(needle),
        )
      : rows;
    return filtered.slice(offset, offset + limit).map(policyRowToDTO);
  }

  async function countPolicies(input?: {
    status?: PolicyDTO["status"];
    q?: string;
  }): Promise<number> {
    ensureLive();
    const needle = (input?.q ?? "").trim().toLowerCase();
    if (!needle) {
      return handle.repos.policies.count({ status: input?.status });
    }
    // q is a client-side substring match; mirror `listPolicies` and
    // walk the full filtered result. Caller passes no limit/offset
    // so the natural list pages through everything.
    const rows = handle.repos.policies.list({ status: input?.status });
    return rows.filter((r) =>
      (r.title + "\n" + r.trigger + "\n" + r.procedure)
        .toLowerCase()
        .includes(needle),
    ).length;
  }

  async function setPolicyStatus(
    id: string,
    status: PolicyDTO["status"],
  ): Promise<PolicyDTO | null> {
    ensureLive();
    const existing = handle.repos.policies.getById(id);
    if (!existing) return null;
    handle.repos.policies.upsert({ ...existing, status, updatedAt: Date.now() });
    const updated = handle.repos.policies.getById(id);
    return updated ? policyRowToDTO(updated) : null;
  }

  async function deletePolicy(id: string): Promise<{ deleted: boolean }> {
    ensureLive();
    const existing = handle.repos.policies.getById(id);
    if (!existing) return { deleted: false };
    handle.repos.policies.deleteById(id);
    return { deleted: true };
  }

  async function editPolicyGuidance(
    id: string,
    patch: { preference?: string[]; antiPattern?: string[] },
  ): Promise<PolicyDTO | null> {
    ensureLive();
    const existing = handle.repos.policies.getById(id);
    if (!existing) return null;
    const current = existing.decisionGuidance;
    const nextPref = dedupeStrings([
      ...current.preference,
      ...(patch.preference ?? []),
    ]);
    const nextAvoid = dedupeStrings([
      ...current.antiPattern,
      ...(patch.antiPattern ?? []),
    ]);
    if (
      nextPref.length === current.preference.length &&
      nextAvoid.length === current.antiPattern.length
    ) {
      return policyRowToDTO(existing);
    }
    handle.repos.policies.upsert({
      ...existing,
      decisionGuidance: { preference: nextPref, antiPattern: nextAvoid },
      updatedAt: Date.now(),
    });
    const updated = handle.repos.policies.getById(id);
    return updated ? policyRowToDTO(updated) : null;
  }

  async function getWorldModel(id: string): Promise<WorldModelDTO | null> {
    ensureLive();
    const row = handle.repos.worldModel.getById(id);
    return row ? worldModelRowToDTO(row) : null;
  }

  async function countWorldModels(input?: { q?: string }): Promise<number> {
    ensureLive();
    const needle = (input?.q ?? "").trim().toLowerCase();
    if (!needle) return handle.repos.worldModel.count();
    const rows = handle.repos.worldModel.list({});
    return rows.filter((r) =>
      (r.title + "\n" + r.body).toLowerCase().includes(needle),
    ).length;
  }

  async function listWorldModels(input?: {
    limit?: number;
    offset?: number;
    q?: string;
  }): Promise<WorldModelDTO[]> {
    ensureLive();
    const limit = Math.max(1, Math.min(500, input?.limit ?? 50));
    const offset = Math.max(0, input?.offset ?? 0);
    const needle = (input?.q ?? "").trim().toLowerCase();
    const rows = handle.repos.worldModel.list({
      limit: limit + offset + (needle ? 200 : 0),
      offset: 0,
    });
    const filtered = needle
      ? rows.filter((r) =>
          (r.title + "\n" + r.body).toLowerCase().includes(needle),
        )
      : rows;
    return filtered.slice(offset, offset + limit).map(worldModelRowToDTO);
  }

  async function deleteWorldModel(id: string): Promise<{ deleted: boolean }> {
    ensureLive();
    const existing = handle.repos.worldModel.getById(id);
    if (!existing) return { deleted: false };
    handle.repos.worldModel.deleteById(id);
    return { deleted: true };
  }

  async function sharePolicy(
    id: string,
    share: {
      scope: "private" | "public" | "hub" | null;
      target?: string | null;
      sharedAt?: number | null;
    },
  ): Promise<PolicyDTO | null> {
    ensureLive();
    const existing = handle.repos.policies.getById(id);
    if (!existing) return null;
    handle.repos.policies.updateShare(id, share);
    const updated = handle.repos.policies.getById(id);
    return updated ? policyRowToDTO(updated) : null;
  }

  async function shareWorldModel(
    id: string,
    share: {
      scope: "private" | "public" | "hub" | null;
      target?: string | null;
      sharedAt?: number | null;
    },
  ): Promise<WorldModelDTO | null> {
    ensureLive();
    const existing = handle.repos.worldModel.getById(id);
    if (!existing) return null;
    handle.repos.worldModel.updateShare(id, share);
    const updated = handle.repos.worldModel.getById(id);
    return updated ? worldModelRowToDTO(updated) : null;
  }

  async function updatePolicy(
    id: string,
    patch: {
      title?: string;
      trigger?: string;
      procedure?: string;
      verification?: string;
      boundary?: string;
    },
  ): Promise<PolicyDTO | null> {
    ensureLive();
    const existing = handle.repos.policies.getById(id);
    if (!existing) return null;
    handle.repos.policies.updateContent(id, patch);
    const updated = handle.repos.policies.getById(id);
    return updated ? policyRowToDTO(updated) : null;
  }

  async function updateWorldModel(
    id: string,
    patch: { title?: string; body?: string; status?: "active" | "archived" },
  ): Promise<WorldModelDTO | null> {
    ensureLive();
    const existing = handle.repos.worldModel.getById(id);
    if (!existing) return null;
    if (patch.title !== undefined || patch.body !== undefined) {
      handle.repos.worldModel.updateContent(id, {
        title: patch.title,
        body: patch.body,
      });
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      handle.repos.worldModel.setStatus(id, patch.status, Date.now());
    }
    const updated = handle.repos.worldModel.getById(id);
    return updated ? worldModelRowToDTO(updated) : null;
  }

  async function archiveWorldModel(id: string): Promise<WorldModelDTO | null> {
    ensureLive();
    const existing = handle.repos.worldModel.getById(id);
    if (!existing) return null;
    if (existing.status !== "archived") {
      handle.repos.worldModel.setStatus(id, "archived", Date.now());
    }
    const updated = handle.repos.worldModel.getById(id);
    return updated ? worldModelRowToDTO(updated) : null;
  }

  async function unarchiveWorldModel(id: string): Promise<WorldModelDTO | null> {
    ensureLive();
    const existing = handle.repos.worldModel.getById(id);
    if (!existing) return null;
    if (existing.status === "archived") {
      handle.repos.worldModel.setStatus(id, "active", Date.now());
    }
    const updated = handle.repos.worldModel.getById(id);
    return updated ? worldModelRowToDTO(updated) : null;
  }

  async function listEpisodes(input: {
    sessionId?: SessionId;
    limit?: number;
    offset?: number;
  }): Promise<EpisodeId[]> {
    ensureLive();
    const rows = handle.repos.episodes.list({
      sessionId: input.sessionId,
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
    });
    return rows.map((r: EpisodeRow) => r.id as EpisodeId);
  }

  async function countEpisodes(input?: {
    sessionId?: SessionId;
  }): Promise<number> {
    ensureLive();
    return handle.repos.episodes.count({ sessionId: input?.sessionId });
  }

  async function listEpisodeRows(input?: {
    sessionId?: SessionId;
    limit?: number;
    offset?: number;
  }): Promise<Parameters<MemoryCore["listEpisodeRows"]> extends unknown[] ? Awaited<ReturnType<MemoryCore["listEpisodeRows"]>> : never> {
    ensureLive();

    // Keep list queries read-only. Startup recovery still handles stale
    // open topics and dirty closed episodes during init; viewer refreshes
    // should not trigger finalize/reflect/reward side effects.
    // await autoFinalizeStaleTasks();
    // await autoRescoreDirtyClosedEpisodes();

    const rows = handle.repos.episodes.list({
      sessionId: input?.sessionId,
      limit: input?.limit ?? 50,
      offset: input?.offset ?? 0,
    });

    // Build reverse indexes for the skill-status derivation. Rebuilt
    // per call rather than cached because the base table volumes are
    // small (policies + skills each ≤ ~1 k rows in practice). This
    // mirrors the legacy `tasks.skill_status` field the user was
    // missing in the Tasks view.
    const allPolicies = handle.repos.policies.list({ limit: 5_000 });
    const allSkills = handle.repos.skills.list({ limit: 5_000 });
    const policiesByEpisode = new Map<string, typeof allPolicies>();
    for (const p of allPolicies) {
      for (const ep of p.sourceEpisodeIds ?? []) {
        const bucket = policiesByEpisode.get(ep) ?? [];
        bucket.push(p);
        policiesByEpisode.set(ep, bucket);
      }
    }
    const skillsByPolicy = new Map<string, typeof allSkills>();
    for (const s of allSkills) {
      for (const pid of s.sourcePolicyIds ?? []) {
        const bucket = skillsByPolicy.get(pid) ?? [];
        bucket.push(s);
        skillsByPolicy.set(pid, bucket);
      }
    }

    // For each row, fetch the episode's traces once. We need the rows
    // for both preview/tags and turn counting: Tasks should count user
    // turns (`turnId` groups), not step-level L1 traces.
    const out = rows.map((r: EpisodeRow) => {
      const firstTraceId = r.traceIds[0];
      const episodeTraces = r.traceIds.length > 0
        ? handle.repos.traces.getManyByIds(r.traceIds as TraceId[])
        : [];
      let preview: string | undefined;
      const tagSet = new Set<string>();
      if (firstTraceId) {
        const trace =
          episodeTraces.find((tr) => tr.id === firstTraceId) ??
          handle.repos.traces.getById(firstTraceId as TraceId);
        if (trace) {
          const raw = (trace.userText ?? trace.agentText ?? "").replace(/\s+/g, " ").trim();
          if (raw) preview = raw.length > 160 ? raw.slice(0, 157) + "…" : raw;
        }
      }
      for (const trace of episodeTraces) {
        for (const t of trace.tags ?? []) tagSet.add(t);
      }

      const derivation = deriveSkillStatus(
        r,
        policiesByEpisode.get(r.id) ?? [],
        skillsByPolicy,
      );

      // `EpisodeManager` stamps `closeReason` and (for abandons)
      // `abandonReason` into the episode's meta blob on finalize /
      // abandon. Surface them through the API so TasksView can render
      // a human-readable status badge without guessing from rTask.
      const meta = (r as { meta?: Record<string, unknown> }).meta ?? {};
      if (!preview) {
        const fallback =
          typeof meta.initialUserText === "string"
            ? meta.initialUserText
            : typeof meta.pendingUserText === "string"
              ? meta.pendingUserText
              : typeof meta.lastUserText === "string"
                ? meta.lastUserText
                : "";
        const raw = fallback.replace(/\s+/g, " ").trim();
        if (raw) preview = raw.length > 160 ? raw.slice(0, 157) + "…" : raw;
      }
      const closeReasonRaw = meta.closeReason;
      const closeReason: "finalized" | "abandoned" | null =
        closeReasonRaw === "finalized" || closeReasonRaw === "abandoned"
          ? closeReasonRaw
          : null;
      const abandonReason =
        typeof meta.abandonReason === "string" ? meta.abandonReason : null;
      const topicStateRaw = meta.topicState;
      const topicState =
        topicStateRaw === "active" ||
        topicStateRaw === "paused" ||
        topicStateRaw === "interrupted" ||
        topicStateRaw === "ended"
          ? topicStateRaw
          : null;
      const pauseReason =
        typeof meta.pauseReason === "string" ? meta.pauseReason : null;
      const reward =
        meta.reward && typeof meta.reward === "object"
          ? (meta.reward as { skipped?: unknown; reason?: unknown })
          : null;
      const rewardSkipped = reward?.skipped === true;
      const rewardReason =
        typeof reward?.reason === "string" && reward.reason.trim().length > 0
          ? reward.reason
          : null;
      const hasAssistantReply = episodeTraces.some((trace) => {
        if ((trace.agentText ?? "").trim().length > 0) return true;
        return (trace.toolCalls ?? []).some((toolCall) => {
          const text = toolCall.assistantTextBefore;
          return typeof text === "string" && text.trim().length > 0;
        });
      });

      return {
        id: r.id,
        sessionId: r.sessionId,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? undefined,
        status: r.status,
        rTask: r.rTask,
        turnCount: deriveTurnCount(r, episodeTraces),
        preview,
        tags: tagSet.size > 0 ? Array.from(tagSet).sort() : undefined,
        skillStatus: derivation.status,
        skillReason: derivation.reason,
        skillReasonKey: derivation.reasonKey,
        skillReasonParams: derivation.reasonParams,
        linkedSkillId: derivation.linkedSkillId,
        closeReason,
        topicState,
        pauseReason,
        abandonReason,
        rewardSkipped,
        rewardReason,
        hasAssistantReply,
      };
    });
    return out as never;
  }

  async function timeline(input: {
    episodeId: EpisodeId;
  }): Promise<TraceDTO[]> {
    ensureLive();
    const episode = handle.repos.episodes.getById(input.episodeId);
    const rows = handle.repos.traces.list({
      episodeId: input.episodeId,
      limit: 500,
      newestFirst: false,
    });
    return orderTraceRowsForEpisode(rows, episode?.traceIds ?? []).map((row) =>
      traceRowToDTO(row, episode),
    );
  }

  async function listApiLogs(input?: {
    toolName?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: ApiLogDTO[]; total: number }> {
    ensureLive();
    const limit = Math.max(1, Math.min(500, input?.limit ?? 50));
    const offset = Math.max(0, input?.offset ?? 0);
    const rows = handle.repos.apiLogs.list({
      toolName: input?.toolName,
      limit,
      offset,
    });
    const total = handle.repos.apiLogs.count({ toolName: input?.toolName });
    return {
      logs: rows.map((r) => ({
        id: r.id,
        toolName: r.toolName,
        inputJson: r.inputJson,
        outputJson: r.outputJson,
        durationMs: r.durationMs,
        success: r.success,
        calledAt: r.calledAt,
      })),
      total,
    };
  }

  async function countTraces(input?: {
    sessionId?: SessionId;
    q?: string;
    groupByTurn?: boolean;
  }): Promise<number> {
    ensureLive();
    const needle = (input?.q ?? "").trim().toLowerCase();
    if (!needle) {
      return input?.groupByTurn
        ? handle.repos.traces.countTurns({ sessionId: input?.sessionId })
        : handle.repos.traces.count({ sessionId: input?.sessionId });
    }
    // q substring scan — mirror `listTraces`. Walk all matching
    // traces from the repo (no limit) and apply the same filter.
    const rows = handle.repos.traces.list({ sessionId: input?.sessionId });
    const matched = rows.filter((r) => {
      return traceSearchHaystack(r).includes(needle);
    });
    if (!input?.groupByTurn) return matched.length;
    const turnKeys = new Set<string>();
    for (const r of matched) turnKeys.add(`${r.episodeId ?? "_"}:${r.turnId}`);
    return turnKeys.size;
  }

  async function listTraces(input?: {
    limit?: number;
    offset?: number;
    sessionId?: SessionId;
    q?: string;
    groupByTurn?: boolean;
  }): Promise<TraceDTO[]> {
    ensureLive();
    const limit = Math.max(1, Math.min(500, input?.limit ?? 50));
    const offset = Math.max(0, input?.offset ?? 0);
    const needle = (input?.q ?? "").trim().toLowerCase();

    if (input?.groupByTurn) {
      // Group-by-turn: paginate at the (episodeId, turnId) level so each
      // "memory" on the Memories page corresponds to one user turn.
      if (!needle) {
        const turnKeys = handle.repos.traces.listTurnKeys({
          sessionId: input?.sessionId,
          limit,
          offset,
        });
        const rows = handle.repos.traces.listByTurnKeys(turnKeys);
        // The frontend's `buildGroups` preserves first-encounter order
        // when bucketing traces by turnKey. We need newest turn first
        // (matching `listTurnKeys` DESC order), with the episode's
        // conversation trace order inside each turn.
        const turnOrder = new Map<string, number>();
        turnKeys.forEach((k, i) =>
          turnOrder.set(`${k.episodeId ?? "_"}:${k.turnId}`, i),
        );
        const traceOrder = traceOrderLookup(rows);
        rows.sort((a, b) => {
          const ka = `${a.episodeId ?? "_"}:${a.turnId}`;
          const kb = `${b.episodeId ?? "_"}:${b.turnId}`;
          const ia = turnOrder.get(ka) ?? 0;
          const ib = turnOrder.get(kb) ?? 0;
          if (ia !== ib) return ia - ib;
          return compareTraceRowsForEpisodeOrder(a, b, traceOrder);
        });
        return traceRowsToDTOs(rows);
      }
      // Search + group: scan, filter, then paginate by distinct turn key.
      const allRows = handle.repos.traces.list({ sessionId: input?.sessionId });
      const matched = allRows.filter((r) => {
        return traceSearchHaystack(r).includes(needle);
      });
      const seen = new Map<string, { episodeId: string | null; turnId: number; maxTs: number }>();
      for (const r of matched) {
        const k = `${r.episodeId ?? "_"}:${r.turnId}`;
        const existing = seen.get(k);
        if (!existing || r.ts > existing.maxTs) {
          seen.set(k, { episodeId: r.episodeId, turnId: r.turnId, maxTs: r.ts });
        }
      }
      const orderedKeys = [...seen.values()]
        .sort((a, b) => b.maxTs - a.maxTs)
        .slice(offset, offset + limit);
      const turnOrder = new Map<string, number>();
      orderedKeys.forEach((k, i) =>
        turnOrder.set(`${k.episodeId ?? "_"}:${k.turnId}`, i),
      );
      // Once a turn matches the search, return the whole turn so the
      // Memories card uses the same step list as the Tasks timeline.
      const rows = handle.repos.traces.listByTurnKeys(orderedKeys);
      const traceOrder = traceOrderLookup(rows);
      const traces = rows
        .sort((a, b) => {
          const ka = `${a.episodeId ?? "_"}:${a.turnId}`;
          const kb = `${b.episodeId ?? "_"}:${b.turnId}`;
          const ia = turnOrder.get(ka) ?? 0;
          const ib = turnOrder.get(kb) ?? 0;
          if (ia !== ib) return ia - ib;
          return compareTraceRowsForEpisodeOrder(a, b, traceOrder);
        });
      return traceRowsToDTOs(traces);
    }

    if (!needle) {
      const rows = handle.repos.traces.list({
        sessionId: input?.sessionId,
        limit,
        offset,
      });
      return traceRowsToDTOs(rows);
    }
    // Substring search: SQLite LIKE would need an index. For the
    // viewer's interactive filter the current volumes (low thousands
    // per install) are cheap enough to do a two-phase scan.
    const batchSize = Math.min(2_000, (limit + offset) * 5);
    const rows = handle.repos.traces.list({
      sessionId: input?.sessionId,
      limit: batchSize,
      offset: 0,
    });
    const filtered = rows.filter((r) => {
      return traceSearchHaystack(r).includes(needle);
    });
    return traceRowsToDTOs(filtered.slice(offset, offset + limit));
  }

  function traceSearchHaystack(row: TraceRow): string {
    return [
      row.id,
      row.episodeId,
      row.summary ?? "",
      row.userText,
      row.agentText,
      summarizeToolCalls(row.toolCalls),
    ].join("\n").toLowerCase();
  }

  function traceRowsToDTOs(rows: readonly TraceRow[]): TraceDTO[] {
    const episodes = new Map<string, EpisodeRow | null>();
    return rows.map((row) => {
      if (!episodes.has(row.episodeId)) {
        episodes.set(row.episodeId, handle.repos.episodes.getById(row.episodeId));
      }
      return traceRowToDTO(row, episodes.get(row.episodeId) ?? undefined);
    });
  }

  function traceOrderLookup(
    rows: readonly TraceRow[],
  ): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    const episodeIds = new Set(rows.map((r) => r.episodeId).filter(Boolean));
    for (const episodeId of episodeIds) {
      const ep = handle.repos.episodes.getById(episodeId);
      if (!ep) continue;
      const order = new Map<string, number>();
      const episodeRows = rows.filter((row) => row.episodeId === episodeId);
      orderTraceRowsForEpisode(episodeRows, ep.traceIds).forEach((row, idx) =>
        order.set(row.id, idx),
      );
      out.set(episodeId, order);
    }
    return out;
  }

  // ─── Skills ──
  async function listSkills(
    input?: { status?: SkillDTO["status"]; limit?: number },
  ): Promise<SkillDTO[]> {
    ensureLive();
    const rows = handle.repos.skills.list({
      status: input?.status,
      limit: input?.limit ?? 50,
    });
    return rows.map(skillRowToDTO);
  }

  async function countSkills(input?: {
    status?: SkillDTO["status"];
  }): Promise<number> {
    ensureLive();
    return handle.repos.skills.count({ status: input?.status });
  }

  async function getSkill(
    id: SkillId,
    opts?: {
      recordUse?: boolean;
      recordTrial?: boolean;
      sessionId?: SessionId;
      episodeId?: EpisodeId;
      traceId?: string;
      turnId?: number;
      toolCallId?: string;
    },
  ): Promise<SkillDTO | null> {
    ensureLive();
    const row = handle.repos.skills.getById(id);
    if (!row) return null;
    if (opts?.recordUse) {
      handle.repos.skills.recordUse(id, Date.now());
      if (opts.recordTrial) {
        recordSkillTrial(id, opts);
      }
      const updated = handle.repos.skills.getById(id);
      return updated ? skillRowToDTO(updated) : skillRowToDTO(row);
    }
    return skillRowToDTO(row);
  }

  function recordSkillTrial(
    skillId: SkillId,
    opts: {
      sessionId?: SessionId;
      episodeId?: EpisodeId;
      traceId?: string;
      turnId?: number;
      toolCallId?: string;
    },
  ): void {
    const episode =
      opts.episodeId
        ? handle.repos.episodes.getById(opts.episodeId)
        : opts.sessionId
          ? handle.repos.episodes.getOpenForSession(opts.sessionId)
          : null;
    if (!episode) {
      rootLogger.child({ channel: "core.skill" }).debug("skill.trial.skipped", {
        skillId,
        reason: "missing_episode",
        sessionId: opts.sessionId,
      });
      return;
    }
    handle.repos.skillTrials.createPending({
      id: `st_${randomUUID()}`,
      skillId,
      sessionId: opts.sessionId ?? episode.sessionId ?? null,
      episodeId: episode.id,
      traceId: opts.traceId ?? null,
      turnId: Number.isFinite(opts.turnId) ? (opts.turnId as number) : null,
      toolCallId: opts.toolCallId ?? null,
      status: "pending",
      createdAt: Date.now(),
      resolvedAt: null,
      evidence: {
        source: "skill_get",
      },
    });
  }

  async function metrics(input?: { days?: number }): Promise<{
    total: number;
    writesToday: number;
    sessions: number;
    embeddings: number;
    dailyWrites: Array<{ date: string; count: number }>;
    skillStats: {
      total: number;
      active: number;
      candidate: number;
      archived: number;
      evolutionRate: number;
    };
    policyStats: {
      total: number;
      active: number;
      candidate: number;
      archived: number;
      avgGain: number;
      avgQuality: number;
    };
    worldModelCount: number;
    decisionRepairCount: number;
    dailySkillEvolutions: Array<{ date: string; count: number }>;
    recentEvolutions: Array<{
      ts: number;
      skillId: string;
      skillName: string;
      status: "candidate" | "active" | "archived";
      sourcePolicyIds: string[];
    }>;
  }> {
    ensureLive();
    const days = Math.max(1, Math.min(365, input?.days ?? 30));
    const now = Date.now();
    const oneDayMs = 86_400_000;
    const sinceMs = now - days * oneDayMs;

    const traces = handle.repos.traces.list({ limit: 10_000 });
    const sessions = new Set<string>();
    let writesToday = 0;
    let embeddings = 0;
    const dayBuckets = new Map<string, number>();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    for (const t of traces) {
      sessions.add(t.sessionId);
      if (t.vecSummary || t.vecAction) embeddings++;
      if (t.ts >= startOfToday.getTime()) writesToday++;
      if (t.ts >= sinceMs) {
        const d = new Date(t.ts);
        d.setHours(0, 0, 0, 0);
        const key = d.toISOString().slice(0, 10);
        dayBuckets.set(key, (dayBuckets.get(key) ?? 0) + 1);
      }
    }

    // Fill missing days with 0 so the chart renders an even baseline.
    const dailyWrites: Array<{ date: string; count: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(startOfToday.getTime() - i * oneDayMs);
      const key = d.toISOString().slice(0, 10);
      dailyWrites.push({ date: key, count: dayBuckets.get(key) ?? 0 });
    }

    // ── V7 progress metrics — skills, policies, L3, repairs ────────────
    const skillRows = handle.repos.skills.list({ limit: 5_000 });
    const policyRows = handle.repos.policies.list({ limit: 5_000 });
    const worldModelCount = handle.repos.worldModel.list({ limit: 5_000 }).length;
    const decisionRepairCount = handle.repos.decisionRepairs.list({ limit: 5_000 }).length;

    const skillByStatus = { active: 0, candidate: 0, archived: 0 } as Record<
      SkillDTO["status"],
      number
    >;
    for (const s of skillRows) skillByStatus[s.status] += 1;

    // Rate of episodes that directly produced a skill — the V7
    // "task → skill" evolution rate. We count an episode as "evolved"
    // if any skill's source policies reference it OR its
    // `meta.skillStatus === 'generated'` flag is set (viewer writes
    // this today).
    const episodeRows = handle.repos.episodes.list({ limit: 5_000 });
    const policyToEpisodes = new Map<string, string[]>();
    for (const p of policyRows) {
      policyToEpisodes.set(p.id, p.sourceEpisodeIds ?? []);
    }
    const evolvedEpisodes = new Set<string>();
    for (const s of skillRows) {
      for (const pid of s.sourcePolicyIds ?? []) {
        for (const epId of policyToEpisodes.get(pid) ?? []) evolvedEpisodes.add(epId);
      }
    }
    const totalTasks = episodeRows.length;
    const evolutionRate = totalTasks > 0 ? evolvedEpisodes.size / totalTasks : 0;

    const policyByStatus = { active: 0, candidate: 0, archived: 0 } as Record<
      PolicyDTO["status"],
      number
    >;
    let gainSum = 0;
    let activeGainCount = 0;
    for (const p of policyRows) {
      policyByStatus[p.status] += 1;
      if (p.status === "active") {
        gainSum += p.gain;
        activeGainCount++;
      }
    }
    const avgGain = activeGainCount > 0 ? gainSum / activeGainCount : 0;

    // Daily skill evolutions: bucket by `skill.createdAt`.
    const evoBuckets = new Map<string, number>();
    for (const s of skillRows) {
      if (s.createdAt < sinceMs) continue;
      const d = new Date(s.createdAt);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      evoBuckets.set(key, (evoBuckets.get(key) ?? 0) + 1);
    }
    const dailySkillEvolutions: Array<{ date: string; count: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(startOfToday.getTime() - i * oneDayMs);
      const key = d.toISOString().slice(0, 10);
      dailySkillEvolutions.push({ date: key, count: evoBuckets.get(key) ?? 0 });
    }

    // Recent crystallisations — newest 20, sorted by createdAt desc.
    const recentEvolutions = [...skillRows]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
      .map((s) => ({
        ts: s.createdAt,
        skillId: s.id,
        skillName: s.name,
        status: s.status,
        sourcePolicyIds: s.sourcePolicyIds ?? [],
      }));

    // Count unique (episodeId, turnId) groups instead of raw traces so
    // the Overview "memories" metric matches what the Memories page
    // shows: 1 user turn = 1 memory (regardless of how many tool calls
    // / sub-steps were captured for that turn).
    const totalTurns = handle.repos.traces.countTurns();

    return {
      total: totalTurns,
      writesToday,
      sessions: sessions.size,
      embeddings,
      dailyWrites,
      skillStats: {
        total: skillRows.length,
        active: skillByStatus.active,
        candidate: skillByStatus.candidate,
        archived: skillByStatus.archived,
        evolutionRate,
      },
      policyStats: {
        total: policyRows.length,
        active: policyByStatus.active,
        candidate: policyByStatus.candidate,
        archived: policyByStatus.archived,
        avgGain,
        // Quality score proxies `gain` — the viewer treats this as
        // the "平均质量分" metric.
        avgQuality: avgGain,
      },
      worldModelCount,
      decisionRepairCount,
      dailySkillEvolutions,
      recentEvolutions,
    };
  }


  async function exportBundle(): Promise<{
    version: 1;
    exportedAt: number;
    traces: TraceDTO[];
    policies: PolicyDTO[];
    worldModels: WorldModelDTO[];
    skills: SkillDTO[];
  }> {
    ensureLive();
    const traces = traceRowsToDTOs(handle.repos.traces.list({ limit: 100_000 }));
    const policies = handle.repos.policies.list({ limit: 5_000 }).map(policyRowToDTO);
    const worldModels = handle.repos.worldModel.list({ limit: 2_000 }).map(worldModelRowToDTO);
    const skills = handle.repos.skills.list({ limit: 5_000 }).map(skillRowToDTO);
    return {
      version: 1,
      exportedAt: Date.now(),
      traces,
      policies,
      worldModels,
      skills,
    };
  }

  async function importBundle(bundle: {
    version?: number;
    traces?: unknown[];
    policies?: unknown[];
    worldModels?: unknown[];
    skills?: unknown[];
  }): Promise<{ imported: number; skipped: number }> {
    ensureLive();
    if (bundle.version && bundle.version !== 1) {
      throw new MemosError("unsupported", `unsupported bundle version: ${bundle.version}`);
    }
    let imported = 0;
    let skipped = 0;

    // Best-effort: only insert rows that don't collide with existing
    // ids. We don't re-mint fresh ids on collision to keep the shape
    // deterministic for the user — they opt in via a de-duplicating
    // pre-pass if they want merging.
    const traces = Array.isArray(bundle.traces) ? bundle.traces : [];

    // Phase 0 — ensure every referenced (sessionId, episodeId) row
    // exists before we try to `traces.insert`. Without this the FK
    // constraint on `traces.episode_id REFERENCES episodes(id)` makes
    // every legacy/external row bounce with "FOREIGN KEY constraint
    // failed". This was the "Imported 0 traces, 0 skills, 0 tasks"
    // bug the user reported on the legacy import button.
    const seenSessions = new Set<string>();
    const seenEpisodes = new Set<string>();
    for (const raw of traces) {
      const dto = raw as TraceDTO;
      if (!dto?.id || !dto.episodeId || !dto.sessionId) continue;
      if (!seenSessions.has(dto.sessionId)) {
        try {
          if (!handle.repos.sessions.getById(dto.sessionId)) {
            handle.repos.sessions.upsert({
              id: dto.sessionId,
              agent: handle.agent,
              startedAt: dto.ts ?? Date.now(),
              lastSeenAt: dto.ts ?? Date.now(),
              meta: { source: "import" },
            } as never);
          }
        } catch {
          // If the synthetic session row is rejected, the FK insert
          // below will fail and be counted as `skipped`. Don't abort
          // the entire import batch for one bad session.
        }
        seenSessions.add(dto.sessionId);
      }
      if (!seenEpisodes.has(dto.episodeId)) {
        try {
          if (!handle.repos.episodes.getById(dto.episodeId)) {
            handle.repos.episodes.upsert({
              id: dto.episodeId,
              sessionId: dto.sessionId,
              startedAt: dto.ts ?? Date.now(),
              endedAt: dto.ts ?? Date.now(),
              traceIds: [],
              rTask: null,
              status: "closed",
              meta: { source: "import" },
            } as never);
          }
        } catch {
          /* see comment above */
        }
        seenEpisodes.add(dto.episodeId);
      }
    }

    for (const raw of traces) {
      try {
        const dto = raw as TraceDTO;
        if (!dto?.id) { skipped++; continue; }
        const existing = handle.repos.traces.getById(dto.id);
        if (existing) { skipped++; continue; }
        // The trace table requires a fuller row shape than TraceDTO.
        // We reconstitute a stub row — vectors are dropped on purpose
        // because we have no way to re-embed bundled text here.
        handle.repos.traces.insert({
          id: dto.id,
          episodeId: dto.episodeId,
          sessionId: dto.sessionId,
          ts: dto.ts,
          userText: dto.userText,
          agentText: dto.agentText,
          toolCalls: dto.toolCalls ?? [],
          reflection: dto.reflection ?? null,
          value: dto.value ?? 0,
          alpha: dto.alpha ?? 0,
          rHuman: dto.rHuman ?? null,
          priority: dto.priority ?? 0,
          tags: [],
          vecSummary: null,
          vecAction: null,
          turnId: dto.turnId,
          schemaVersion: 1,
        } as TraceRow);
        imported++;
      } catch {
        skipped++;
      }
    }

    // Policies / world models / skills use existing repo.insert shape.
    for (const raw of bundle.policies ?? []) {
      try {
        const dto = raw as PolicyDTO;
        if (!dto?.id || handle.repos.policies.getById(dto.id)) { skipped++; continue; }
        handle.repos.policies.insert({
          id: dto.id,
          title: dto.title,
          trigger: dto.trigger,
          procedure: dto.procedure,
          verification: dto.verification,
          boundary: dto.boundary,
          support: dto.support ?? 0,
          gain: dto.gain ?? 0,
          status: dto.status,
          sourceEpisodeIds: [],
          inducedBy: "import",
          decisionGuidance: {
            preference: [...(dto.preference ?? [])],
            antiPattern: [...(dto.antiPattern ?? [])],
          },
          vec: null,
          createdAt: dto.createdAt ?? Date.now(),
          updatedAt: dto.updatedAt ?? Date.now(),
        });
        imported++;
      } catch {
        skipped++;
      }
    }

    for (const raw of bundle.skills ?? []) {
      try {
        const dto = raw as SkillDTO;
        if (!dto?.id || handle.repos.skills.getById(dto.id)) { skipped++; continue; }
        handle.repos.skills.insert({
          id: dto.id,
          name: dto.name,
          status: dto.status,
          invocationGuide: dto.invocationGuide,
          eta: dto.eta ?? 0,
          support: dto.support ?? 0,
          gain: dto.gain ?? 0,
          trialsAttempted: 0,
          trialsPassed: 0,
          sourcePolicyIds: dto.sourcePolicyIds ?? [],
          sourceWorldModelIds: dto.sourceWorldModelIds ?? [],
          evidenceAnchors: dto.evidenceAnchors ?? [],
          procedureJson: {},
          vec: null,
          createdAt: dto.createdAt ?? Date.now(),
          updatedAt: dto.updatedAt ?? Date.now(),
          version: dto.version ?? 1,
          usageCount: dto.usageCount ?? 0,
          lastUsedAt: dto.lastUsedAt ?? null,
        } as SkillRow);
        imported++;
      } catch {
        skipped++;
      }
    }

    for (const raw of bundle.worldModels ?? []) {
      try {
        const dto = raw as WorldModelDTO;
        if (!dto?.id || handle.repos.worldModel.getById(dto.id)) { skipped++; continue; }
        handle.repos.worldModel.insert({
          id: dto.id,
          title: dto.title,
          body: dto.body,
          structure: { environment: [], inference: [], constraints: [] },
          domainTags: [],
          confidence: 0.5,
          policyIds: dto.policyIds ?? [],
          sourceEpisodeIds: [],
          inducedBy: "import",
          vec: null,
          createdAt: dto.createdAt ?? Date.now(),
          updatedAt: dto.updatedAt ?? Date.now(),
          version: dto.version ?? 1,
          status: dto.status ?? "active",
        } as WorldModelRow);
        imported++;
      } catch {
        skipped++;
      }
    }

    return { imported, skipped };
  }

  async function getConfig(): Promise<Record<string, unknown>> {
    ensureLive();
    // Re-read from disk instead of returning `handle.config` (the
    // plugin-bootstrap cache). The viewer's "saveAndRestart" flow
    // writes to disk → PATCH succeeds → the next GET MUST show the
    // new value. Returning the cached object meant any GET before the
    // gateway actually restarted showed stale defaults, which looked
    // like "my settings got wiped" from the user's perspective.
    //
    // We still reach into `handle.home` (paths) which doesn't change
    // at runtime. Failure (deleted file, parse error) falls back to
    // the cached snapshot so settings never appear blank mid-edit.
    try {
      const { loadConfig } = await import("../config/index.js");
      const { config } = await loadConfig(handle.home);
      return maskSecrets(config as unknown as Record<string, unknown>);
    } catch (err) {
      log.warn("config.read_from_disk_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return maskSecrets(handle.config as unknown as Record<string, unknown>);
    }
  }

  async function patchConfig(
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    ensureLive();
    const { patchConfig: applyPatch } = await import("../config/writer.js");
    // Drop blank strings on secret fields so the user can leave them
    // empty in the UI without wiping their existing value.
    const filtered = stripEmptySecrets(patch);
    const result = await applyPatch(handle.home, filtered);
    return maskSecrets(result.config as unknown as Record<string, unknown>);
  }

  async function archiveSkill(id: SkillId, reason?: string): Promise<void> {
    ensureLive();
    const existing = handle.repos.skills.getById(id);
    if (!existing) {
      throw new MemosError("skill_not_found", `skill not found: ${id}`);
    }
    const now = Date.now();
    handle.repos.skills.setStatus(id, "archived", now);
    handle.buses.skill.emit({
      kind: "skill.status.changed",
      at: now,
      skillId: id,
      previous: existing.status,
      next: "archived",
      transition: "archived",
    });
    const allowedReasons = ["eta-floor", "manual", "policy-rebuilt"] as const;
    type ArchiveReason = (typeof allowedReasons)[number];
    const normalizedReason: ArchiveReason =
      allowedReasons.includes(reason as ArchiveReason)
        ? (reason as ArchiveReason)
        : "manual";
    handle.buses.skill.emit({
      kind: "skill.archived",
      at: now,
      skillId: id,
      reason: normalizedReason,
    });
  }

  async function deleteSkill(id: SkillId): Promise<{ deleted: boolean }> {
    ensureLive();
    const existing = handle.repos.skills.getById(id);
    if (!existing) return { deleted: false };
    handle.repos.skills.deleteById(id);
    return { deleted: true };
  }

  async function reactivateSkill(id: SkillId): Promise<SkillDTO | null> {
    ensureLive();
    const existing = handle.repos.skills.getById(id);
    if (!existing) return null;
    const now = Date.now();
    handle.repos.skills.setStatus(id, "active", now);
    if (existing.status !== "active") {
      handle.buses.skill.emit({
        kind: "skill.status.changed",
        at: now,
        skillId: id,
        previous: existing.status,
        next: "active",
        // Closest match in the constrained `SkillLifecycleTransition`
        // enum — manually re-promoting a previously-archived skill.
        transition: "promoted",
      });
    }
    const updated = handle.repos.skills.getById(id);
    return updated ? skillRowToDTO(updated) : null;
  }

  async function updateSkill(
    id: SkillId,
    patch: { name?: string; invocationGuide?: string },
  ): Promise<SkillDTO | null> {
    ensureLive();
    const existing = handle.repos.skills.getById(id);
    if (!existing) return null;
    handle.repos.skills.updateContent(id, patch);
    const updated = handle.repos.skills.getById(id);
    return updated ? skillRowToDTO(updated) : null;
  }

  async function shareSkill(
    id: SkillId,
    share: {
      scope: "private" | "public" | "hub" | null;
      target?: string | null;
      sharedAt?: number | null;
    },
  ): Promise<SkillDTO | null> {
    ensureLive();
    const existing = handle.repos.skills.getById(id);
    if (!existing) return null;
    handle.repos.skills.updateShare(id, share);
    const updated = handle.repos.skills.getById(id);
    return updated ? skillRowToDTO(updated) : null;
  }

  // ─── Observability ──
  function subscribeEvents(handler: (e: CoreEvent) => void): Unsubscribe {
    return handle.subscribeEvents(handler);
  }

  function getRecentEvents(): readonly CoreEvent[] {
    return handle.getRecentEvents();
  }

  function subscribeLogs(handler: (r: LogRecord) => void): Unsubscribe {
    return handle.subscribeLogs(handler);
  }

  function forwardLog(record: LogRecord): void {
    rootLogger.forward(record);
  }

  return {
    init,
    shutdown,
    health,
    openSession,
    closeSession,
    openEpisode,
    closeEpisode,
    onTurnStart,
    onTurnEnd,
    submitFeedback,
    recordToolOutcome,
    recordSubagentOutcome,
    searchMemory,
    getTrace,
    updateTrace,
    deleteTrace,
    deleteTraces,
    shareTrace,
    getPolicy,
    listPolicies,
    countPolicies,
    setPolicyStatus,
    deletePolicy,
    editPolicyGuidance,
    getWorldModel,
    listWorldModels,
    countWorldModels,
    deleteWorldModel,
    sharePolicy,
    shareWorldModel,
    updatePolicy,
    updateWorldModel,
    archiveWorldModel,
    unarchiveWorldModel,
    listEpisodes,
    listEpisodeRows,
    countEpisodes,
    timeline,
    listTraces,
    countTraces,
    listApiLogs,
    listSkills,
    countSkills,
    getSkill,
    archiveSkill,
    deleteSkill,
    reactivateSkill,
    updateSkill,
    shareSkill,
    getConfig,
    patchConfig,
    metrics,
    exportBundle,
    importBundle,
    subscribeEvents,
    getRecentEvents,
    subscribeLogs,
    forwardLog,
  };
}

// ─── Config helpers ──────────────────────────────────────────────────────────

/**
 * Replace every value under `SECRET_FIELD_PATHS` with a placeholder.
 * The rest of the tree is deep-cloned so callers can safely mutate
 * the returned object.
 */
function maskSecrets(src: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
  for (const dotted of SECRET_FIELD_PATHS) {
    const keys = dotted.split(".");
    let cursor: Record<string, unknown> = cloned;
    for (let i = 0; i < keys.length - 1; i++) {
      const next = cursor[keys[i]!];
      if (next == null || typeof next !== "object") {
        cursor = {} as Record<string, unknown>;
        break;
      }
      cursor = next as Record<string, unknown>;
    }
    const leaf = keys[keys.length - 1]!;
    if (typeof cursor[leaf] === "string" && (cursor[leaf] as string).length > 0) {
      // Use ASCII-only placeholder. Earlier versions used the
      // Unicode bullet `•` (U+2022), but browsers reject that
      // character in HTTP `Authorization` headers (ByteString rule:
      // codepoint must be ≤ 0xFF). When the viewer round-tripped the
      // placeholder back through the "Test connection" button the
      // fetch would throw "Cannot convert argument to a ByteString…".
      //
      // Picking an ASCII sentinel keeps the form rehydration logic
      // in `stripEmptySecrets` simple AND lets the viewer detect the
      // placeholder client-side without worrying about encoding.
      cursor[leaf] = "__memos_secret__";
    }
  }
  return cloned;
}

/**
 * Secret keys with empty string values are dropped from the patch so
 * "save" in the UI doesn't wipe an already-configured API key when the
 * form was just rehydrated with the mask and left unchanged.
 */
function stripEmptySecrets(patch: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;
  for (const dotted of SECRET_FIELD_PATHS) {
    const keys = dotted.split(".");
    let cursor: Record<string, unknown> | undefined = out;
    for (let i = 0; i < keys.length - 1; i++) {
      const next = cursor?.[keys[i]!];
      if (next == null || typeof next !== "object") {
        cursor = undefined;
        break;
      }
      cursor = next as Record<string, unknown>;
    }
    if (!cursor) continue;
    const leaf = keys[keys.length - 1]!;
    if (
      cursor[leaf] === "" ||
      cursor[leaf] === "••••" ||
      cursor[leaf] === "__memos_secret__"
    ) {
      delete cursor[leaf];
    }
  }
  return out;
}

function orderTraceRowsForEpisode(
  rows: readonly TraceRow[],
  traceIds: readonly TraceId[],
): TraceRow[] {
  if (traceIds.length === 0) return anchorSubagentRowsForDisplay([...rows]);
  const order = new Map<string, number>();
  traceIds.forEach((id, idx) => order.set(id, idx));
  const ordered = [...rows].sort((a, b) => {
    const ai = order.get(a.id) ?? Number.POSITIVE_INFINITY;
    const bi = order.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.ts - b.ts;
  });
  return anchorSubagentRowsForDisplay(ordered);
}

function anchorSubagentRowsForDisplay(rows: TraceRow[]): TraceRow[] {
  const delegateByToolCallId = new Map<string, string>();
  const delegateByGoal = new Map<string, string>();
  const duplicateGoals = new Set<string>();
  for (const row of rows) {
    const tool = row.toolCalls[0];
    if (tool?.name !== "delegate_task") continue;
    if (tool.toolCallId) delegateByToolCallId.set(tool.toolCallId, row.id);
    const goal = delegateRowGoal(row);
    if (goal) {
      if (delegateByGoal.has(goal)) duplicateGoals.add(goal);
      else delegateByGoal.set(goal, row.id);
    }
  }
  for (const goal of duplicateGoals) delegateByGoal.delete(goal);
  if (delegateByToolCallId.size === 0 && delegateByGoal.size === 0) return rows;

  const groups: Array<{ delegateId: string; rows: TraceRow[] }> = [];
  const groupedIds = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (groupedIds.has(row.id)) continue;
    const delegateId = subagentRowDelegateId(row, delegateByToolCallId, delegateByGoal);
    if (!delegateId) continue;
    const relatedTextRows: TraceRow[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const prev = rows[j]!;
      if (groupedIds.has(prev.id)) continue;
      if (!isSubagentTextRow(prev)) break;
      relatedTextRows.unshift(prev);
    }
    const group = [row, ...relatedTextRows];
    groupedIds.add(row.id);
    for (const related of relatedTextRows) groupedIds.add(related.id);
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j]!;
      if (
        next.toolCalls.length > 0 ||
        groupedIds.has(next.id) ||
        !isSubagentTextRow(next)
      ) {
        break;
      }
      group.push(next);
      groupedIds.add(next.id);
    }
    groups.push({ delegateId, rows: group });
  }
  if (groups.length === 0) return rows;

  let ordered = rows.filter((row) => !groupedIds.has(row.id));
  for (const group of groups) {
    const delegateIdx = ordered.findIndex((row) => row.id === group.delegateId);
    if (delegateIdx < 0) {
      ordered.push(...group.rows);
      continue;
    }
    ordered = [
      ...ordered.slice(0, delegateIdx + 1),
      ...group.rows,
      ...ordered.slice(delegateIdx + 1),
    ];
  }
  return moveDisplayUserTextToAnchoredDelegates(ordered);
}

function isSubagentTextRow(row: TraceRow): boolean {
  return row.toolCalls.length === 0 &&
    (
      row.agentText.includes("Subagent task:") ||
      row.agentText.includes("Subagent result:")
    );
}

function moveDisplayUserTextToAnchoredDelegates(rows: TraceRow[]): TraceRow[] {
  let out = rows;
  let cloned = false;
  const clone = (): TraceRow[] => {
    if (!cloned) {
      out = out.map((row) => ({ ...row }));
      cloned = true;
    }
    return out;
  };

  for (let i = 0; i < out.length; i++) {
    const delegate = out[i]!;
    if (delegate.toolCalls[0]?.name !== "delegate_task" || delegate.userText.trim()) continue;
    for (let j = i + 1; j < out.length; j++) {
      const candidate = out[j]!;
      if (candidate.turnId !== delegate.turnId) break;
      if (candidate.toolCalls[0]?.name === "delegate_task") break;
      if (candidate.toolCalls[0]?.name !== "subagent" || !candidate.userText.trim()) continue;
      const next = clone();
      next[i] = { ...next[i]!, userText: candidate.userText };
      next[j] = { ...next[j]!, userText: "" };
      break;
    }
  }
  return out;
}

function subagentRowDelegateId(
  row: TraceRow,
  delegateByToolCallId: ReadonlyMap<string, string>,
  delegateByGoal: ReadonlyMap<string, string>,
): string | null {
  const toolCallId = subagentRowToolCallId(row);
  if (toolCallId) {
    const byId = delegateByToolCallId.get(toolCallId);
    if (byId) return byId;
  }
  const task = subagentRowTask(row);
  return task ? delegateByGoal.get(task) ?? null : null;
}

function subagentRowToolCallId(row: TraceRow): string | null {
  const tool = row.toolCalls[0];
  if (tool?.name !== "subagent") return null;
  const input = tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
    ? tool.input as Record<string, unknown>
    : null;
  const meta = input && input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
    ? input.meta as Record<string, unknown>
    : {};
  const hookKwargs = meta.hookKwargs && typeof meta.hookKwargs === "object" && !Array.isArray(meta.hookKwargs)
    ? meta.hookKwargs as Record<string, unknown>
    : {};
  return firstNonEmptyString(
    meta.toolCallId,
    meta.tool_call_id,
    meta.callId,
    meta.call_id,
    hookKwargs.toolCallId,
    hookKwargs.tool_call_id,
    hookKwargs.callId,
    hookKwargs.call_id,
  );
}

function subagentRowTask(row: TraceRow): string | null {
  const tool = row.toolCalls[0];
  if (tool?.name !== "subagent") return null;
  const input = topLevelRecord(tool.input);
  return firstNonEmptyString(input?.task);
}

function delegateRowGoal(row: TraceRow): string | null {
  const tool = row.toolCalls[0];
  if (tool?.name !== "delegate_task") return null;
  const input = topLevelJsonObject(tool.input);
  return firstNonEmptyString(input?.goal);
}

function topLevelRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function topLevelJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function compareTraceRowsForEpisodeOrder(
  a: TraceRow,
  b: TraceRow,
  lookup: ReadonlyMap<string, ReadonlyMap<string, number>>,
): number {
  if (a.episodeId === b.episodeId) {
    const order = lookup.get(a.episodeId);
    if (order) {
      const ai = order.get(a.id) ?? Number.POSITIVE_INFINITY;
      const bi = order.get(b.id) ?? Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
    }
  }
  return a.ts - b.ts;
}

// ─── Row → DTO mappers ───────────────────────────────────────────────────────

export function traceRowToDTO(row: TraceRow, episode?: EpisodeRow | null): TraceDTO {
  return {
    id: row.id,
    episodeId: row.episodeId,
    sessionId: row.sessionId,
    ts: row.ts,
    userText: row.userText,
    agentText: row.agentText,
    summary: row.summary ?? null,
    tags: row.tags ?? [],
    share: row.share ?? null,
    toolCalls: row.toolCalls,
    agentThinking: row.agentThinking ?? null,
    reflection: row.reflection ?? undefined,
    value: row.value,
    alpha: row.alpha,
    rHuman: row.rHuman ?? undefined,
    priority: row.priority,
    episodeStatus: episode?.status,
    episodeRTask: episode?.rTask ?? null,
    episodeRewardSkipped: episodeRewardSkipped(episode),
    turnId: row.turnId,
  };
}

function episodeRewardSkipped(episode?: EpisodeRow | null): boolean {
  const meta = (episode as { meta?: Record<string, unknown> } | null | undefined)?.meta;
  const reward = meta?.reward;
  return Boolean(reward && typeof reward === "object" && (reward as { skipped?: unknown }).skipped === true);
}

export function policyRowToDTO(row: PolicyRow): PolicyDTO {
  return {
    id: row.id,
    title: row.title,
    trigger: row.trigger,
    procedure: row.procedure,
    verification: row.verification,
    boundary: row.boundary,
    support: row.support,
    gain: row.gain,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // PolicyDTO surface keeps the flat shape the viewer's PoliciesView
    // already renders. The structured `decisionGuidance` lives on the
    // storage row (column `decision_guidance_json`); we just unpack it
    // here so the DTO doesn't change.
    preference: row.decisionGuidance.preference,
    antiPattern: row.decisionGuidance.antiPattern,
    sourceEpisodeIds: [...(row.sourceEpisodeIds ?? [])],
    share: row.share ?? null,
    editedAt: row.editedAt ?? undefined,
  };
}

function dedupeStrings(lines: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const s = (raw ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function worldModelRowToDTO(row: WorldModelRow): WorldModelDTO {
  // Surface the structured (ℰ, ℐ, 𝒞) triple so the viewer can render
  // entry-level evidence chips (V7 §1.1). `body` stays as the rendered
  // markdown summary used by retrieval injection and the embedder, so
  // both pathways stay coherent. Each facet defaults to `[]` because
  // a world model is allowed to populate only some facets (e.g. only
  // constraints) — the empty slots aren't an error.
  const s = row.structure;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    structure: {
      environment: s.environment ?? [],
      inference: s.inference ?? [],
      constraints: s.constraints ?? [],
    },
    policyIds: row.policyIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version ?? 1,
    status: row.status ?? "active",
    share: row.share ?? null,
    editedAt: row.editedAt ?? undefined,
  };
}

export function skillRowToDTO(row: SkillRow): SkillDTO {
  // Surface `procedureJson.decisionGuidance` as a top-level DTO field
  // so the viewer doesn't have to reach into the structured procedure
  // blob. The shape is fixed by `SkillProcedure`, but the JSON column
  // is `unknown` to repos so we coerce defensively here — protects
  // against a malformed LLM draft, NOT against missing legacy data.
  const proc = (row.procedureJson ?? {}) as {
    decisionGuidance?: { preference?: unknown; antiPattern?: unknown };
  };
  const dg = proc.decisionGuidance;
  const decisionGuidance = {
    preference:
      dg && Array.isArray(dg.preference)
        ? (dg.preference as unknown[]).map((s) => String(s)).filter(Boolean)
        : [],
    antiPattern:
      dg && Array.isArray(dg.antiPattern)
        ? (dg.antiPattern as unknown[]).map((s) => String(s)).filter(Boolean)
        : [],
  };
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    invocationGuide: row.invocationGuide,
    decisionGuidance,
    evidenceAnchors: row.evidenceAnchors,
    eta: row.eta,
    support: row.support,
    gain: row.gain,
    trialsAttempted: row.trialsAttempted ?? 0,
    trialsPassed: row.trialsPassed ?? 0,
    sourcePolicyIds: row.sourcePolicyIds,
    sourceWorldModelIds: row.sourceWorldModelIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version ?? 1,
    share: row.share ?? null,
    editedAt: row.editedAt ?? undefined,
    usageCount: row.usageCount ?? 0,
    lastUsedAt: row.lastUsedAt ?? null,
  };
}

function toFeedbackDTO(row: FeedbackRow): FeedbackDTO {
  return {
    id: row.id,
    ts: row.ts,
    episodeId: row.episodeId ?? undefined,
    traceId: row.traceId ?? undefined,
    channel: row.channel,
    polarity: row.polarity,
    magnitude: row.magnitude,
    rationale: row.rationale ?? undefined,
    raw: row.raw,
  };
}

export function inferTier(
  kind:
    | "skill"
    | "trace"
    | "episode"
    | "world-model"
    | "preference"
    | "anti-pattern",
): 1 | 2 | 3 {
  if (kind === "skill") return 1;
  if (kind === "world-model") return 3;
  return 2;
}

function eventTime(evt: unknown): number {
  const at = (evt as { at?: unknown } | null)?.at;
  return typeof at === "number" && Number.isFinite(at) ? at : Date.now();
}

function durationSince(
  startedAt: number | undefined | null,
  endedAt = Date.now(),
  fallbackMs = 0,
): number {
  if (
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt) ||
    endedAt <= startedAt
  ) {
    return fallbackMs;
  }
  return Math.max(fallbackMs, Math.round(endedAt - startedAt));
}

/**
 * Narrow helper that wraps the api_logs.insert call with the same
 * failure-tolerance all bus subscribers use — we never want logging
 * to break the pipeline.
 */
/**
 * Decide what "skill crystallization model" the viewer should display.
 *
 * Users configure this in Settings → AI Models → 技能进化模型; when they
 * leave it blank (`skillEvolver.model === ""`), the core falls back to
 * the main `llm.*` model for skill induction. We surface that fallback
 * explicitly so the Overview card can label it as "inherited from LLM".
 */
function applyPersistedModelStatus(
  repos: PipelineHandle["repos"],
  role: "embedding" | "llm" | "skillEvolver",
  info: CoreHealth["llm"],
): void {
  const latest = findLatestPersistedModelStatus(repos, role, info.provider, info.model);
  if (!latest) return;
  info.lastOkAt = latest.status === "ok" ? latest.at : null;
  info.lastFallbackAt = latest.status === "fallback" ? latest.at : null;
  info.lastError =
    latest.status === "error" || latest.status === "fallback"
      ? { at: latest.at, message: latest.message || "(no message)" }
      : null;
}

function findLatestPersistedModelStatus(
  repos: PipelineHandle["repos"],
  role: "embedding" | "llm" | "skillEvolver",
  provider: string,
  model: string,
): {
  status: "ok" | "fallback" | "error";
  at: number;
  message?: string;
} | null {
  try {
    const rows = repos.apiLogs.list({
      toolName: "system_model_status",
      limit: 500,
      offset: 0,
    });
    for (const row of rows) {
      try {
        const out = JSON.parse(row.outputJson) as {
          role?: unknown;
          status?: unknown;
          provider?: unknown;
          model?: unknown;
          message?: unknown;
        };
        if (out.role !== role) continue;
        // Only apply status rows for the currently configured model.
        // This prevents an old 404 for a typo'd model from keeping the
        // card red after the operator fixes Settings and restarts.
        if (String(out.provider ?? "") !== provider) continue;
        if (String(out.model ?? "") !== model) continue;
        if (out.status !== "ok" && out.status !== "fallback" && out.status !== "error") {
          continue;
        }
        return {
          status: out.status,
          at: row.calledAt,
          message: typeof out.message === "string" ? out.message : undefined,
        };
      } catch {
        // Malformed row — skip and keep walking.
      }
    }
  } catch {
    // Repo failure is non-fatal for health; leave in-memory stats.
  }
  return null;
}

function retrievalStatsPayload(s: import("../retrieval/types.js").RetrievalStats): {
  raw?: number;
  ranked?: number;
  droppedByThreshold?: number;
  thresholdFloor?: number;
  topRelevance?: number;
  llmFilter?: {
    outcome?: string;
    kept?: number;
    dropped?: number;
    sufficient?: boolean | null;
  };
  channelHits?: Record<string, number>;
  queryTokens?: number;
  queryTags?: string[];
  embedding?: import("../retrieval/types.js").RetrievalStats["embedding"];
} {
  return {
    raw: s.rawCandidateCount,
    ranked: s.rankedCount,
    droppedByThreshold: s.droppedByThresholdCount,
    thresholdFloor: s.thresholdFloor,
    topRelevance: s.topRelevance,
    llmFilter: {
      outcome: s.llmFilterOutcome,
      kept: s.llmFilterKept,
      dropped: s.llmFilterDropped,
      sufficient: s.llmFilterSufficient ?? null,
    },
    channelHits: s.channelHits as Record<string, number> | undefined,
    queryTokens: s.queryTokens,
    queryTags: s.queryTags,
    embedding: s.embedding,
  };
}

function llmHealth(
  llm: PipelineHandle["llm"],
  // Kept in the signature for source compatibility with older callers
  // but intentionally unused — see comment below.
  _fallbackTs: number | null,
): CoreHealth["llm"] {
  if (!llm) {
    return {
      available: false,
      provider: "none",
      model: "",
      lastOkAt: null,
      lastFallbackAt: null,
      lastError: null,
    };
  }
  const s = llm.stats();
  // We deliberately DO NOT fall back to the latest trace timestamp
  // here. Doing so used to paint the slot "connected" on every
  // restart even when the configured model was actually broken — any
  // historical trace from a prior, working configuration would mask
  // a fresh authentication / model-name failure. Now the colour is
  // driven entirely by *this process's* facade activity.
  return {
    available: true,
    provider: llm.provider,
    model: llm.model,
    lastOkAt: s.lastOkAt,
    lastFallbackAt: s.lastFallbackAt,
    lastError: s.lastError,
  };
}

function embedderHealth(
  embedder: PipelineHandle["embedder"],
  _fallbackTs: number | null,
): CoreHealth["embedder"] {
  if (!embedder) {
    return {
      available: false,
      provider: "none",
      model: "",
      dim: 0,
      lastOkAt: null,
      lastFallbackAt: null,
      lastError: null,
    };
  }
  const s = embedder.stats();
  // No `?? fallbackTs` here either — see `llmHealth`. The embedder
  // also has no host fallback path, so `lastFallbackAt` stays `null`
  // by definition.
  return {
    available: true,
    provider: embedder.provider,
    model: embedder.model,
    dim: embedder.dimensions,
    lastOkAt: s.lastOkAt,
    lastFallbackAt: null,
    lastError: s.lastError,
  };
}

function resolveSkillEvolver(
  config: PipelineHandle["config"],
  llm: PipelineHandle["llm"],
  fallbackTs: number | null,
): CoreHealth["skillEvolver"] {
  const evolver = (config as { skillEvolver?: { provider?: string; model?: string } })
    .skillEvolver;
  const own = (evolver?.model ?? "").trim();
  if (own) {
    // `llm` here is the dedicated `reflectLlm` instance built from the
    // skillEvolver config (see `bootstrapMemoryCoreFull`). Reading its
    // stats means the Overview card flips red as soon as a skill
    // crystallization call fails — independent of the summary LLM.
    const s = llm?.stats();
    return {
      available: true,
      provider: evolver?.provider ?? "",
      model: own,
      inherited: false,
      lastOkAt: s?.lastOkAt ?? null,
      lastFallbackAt: s?.lastFallbackAt ?? null,
      lastError: s?.lastError ?? null,
    };
  }
  const fallback = llmHealth(llm, fallbackTs);
  return {
    available: fallback.available,
    provider: fallback.provider,
    model: fallback.model,
    inherited: true,
    lastOkAt: fallback.lastOkAt,
    lastFallbackAt: fallback.lastFallbackAt,
    lastError: fallback.lastError,
  };
}

function writeApiLog(
  handle: PipelineHandle,
  log: Logger,
  toolName: string,
  input: unknown,
  output: unknown,
  durationMs: number,
  success: boolean,
): void {
  try {
    handle.repos.apiLogs.insert({
      toolName,
      input,
      output,
      durationMs,
      success,
      calledAt: Date.now(),
    });
  } catch (err) {
    log.debug(`apiLogs.${toolName}.skipped`, {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best-effort lookup helpers for stamping a triggering `episodeId` on
 * `skill_*` / `world_model_*` api_log rows. The Logs viewer groups
 * events by episode for its chain-timeline view; without this the
 * skill / L3 lifecycle rows would float as standalone cards. Lookup
 * failures are silently absorbed — the row is still written, just
 * without an episode binding.
 */
function episodeFromPolicy(
  handle: PipelineHandle,
  policyId: string | undefined,
): string | undefined {
  if (!policyId) return undefined;
  try {
    const row = handle.repos.policies.getById(policyId as PolicyId);
    if (!row) return undefined;
    // Prefer the most recently attributed episode — that's the one the
    // user just witnessed and the one the rest of the pipeline events
    // (memory_add / task_done) are stamped with.
    return (
      row.sourceEpisodeIds[row.sourceEpisodeIds.length - 1] ??
      row.sourceEpisodeIds[0]
    );
  } catch {
    return undefined;
  }
}

function episodeFromSkill(
  handle: PipelineHandle,
  skillId: string | undefined,
): string | undefined {
  if (!skillId) return undefined;
  try {
    const row = handle.repos.skills.getById(skillId as SkillId);
    if (!row) return undefined;
    return episodeFromPolicy(handle, row.sourcePolicyIds[0]);
  } catch {
    return undefined;
  }
}

function episodeFromWorldModel(
  handle: PipelineHandle,
  worldModelId: string | undefined,
): string | undefined {
  if (!worldModelId) return undefined;
  try {
    const row = handle.repos.worldModel.getById(worldModelId as WorldModelId);
    if (!row) return undefined;
    return (
      row.sourceEpisodeIds[row.sourceEpisodeIds.length - 1] ??
      row.sourceEpisodeIds[0] ??
      episodeFromPolicy(handle, row.policyIds[0])
    );
  } catch {
    return undefined;
  }
}

/**
 * Derive a human-readable skill-crystallisation status for an
 * episode ("task") from the raw episode row + its related policies /
 * skills. Mirrors the legacy `tasks.skill_status` / `skill_reason`
 * fields so the Tasks page can show the user *why* a completed task
 * produced no skill.
 *
 * Order matters: we return the first matching branch.
 */
/**
 * Derive a meaningful user-turn count for the viewer's task list.
 *
 * L1 traces are step-level rows: one user request can produce many tool
 * traces plus a final assistant trace. `turnId` is the stable group key
 * stamped on every trace created from the same user message, so the Tasks
 * tab should count distinct `turnId`s rather than raw trace ids.
 */
export function deriveTurnCount(
  r: EpisodeRow,
  traces: readonly Pick<TraceRow, "turnId">[] = [],
): number {
  if (traces.length > 0) {
    return new Set(
      traces
        .map((trace) => trace.turnId)
        .filter((turnId) => Number.isFinite(turnId)),
    ).size;
  }
  if (r.traceIds.length > 0) return 1;
  return r.status === "open" ? 1 : 0;
}

// V7 §0.6 threshold tiering for the "skill pipeline pill" shown on each
// task card. Reward scores live in [-1, 1] but the UI needs a 3-way
// bucket that actually matches user intuition:
//
//   rTask <= R_NEGATIVE_FLOOR  → true anti-pattern, label as 反例
//   R_NEGATIVE_FLOOR < rTask < R_BELOW_THRESHOLD → just "未达沉淀阈值"
//   rTask >= R_BELOW_THRESHOLD → eligible, continue to L2/skill checks
//
// The old code tripped every rTask < 0 (even -0.05) into the "反例"
// bucket — a single LLM misread on a multi-topic episode was enough to
// flag a normal task as a negative example. Tightening the floor to
// −0.5 means only genuinely bad outcomes (clear user correction, wrong
// action, damage) surface as 反例; mild negative judgments fall into
// the softer "below threshold" bucket and the user doesn't get
// shouted at.
export const R_NEGATIVE_FLOOR = -0.5;
export const R_BELOW_THRESHOLD = 0.15; // aligned with `algorithm.skill.minGain`

export function deriveSkillStatus(
  ep: EpisodeRow,
  relatedPolicies: readonly PolicyRow[],
  skillsByPolicy: ReadonlyMap<string, readonly SkillRow[]>,
): {
  status: EpisodeListItemDTO["skillStatus"];
  reason: string | null;
  reasonKey: string | null;
  reasonParams: Record<string, string> | null;
  linkedSkillId: SkillId | null;
} {
  if (ep.status === "open") {
    return {
      status: "queued",
      reason: "任务仍在进行中，技能流水线尚未启动",
      reasonKey: "tasks.skillReason.queued.inProgress",
      reasonParams: null,
      linkedSkillId: null,
    };
  }
  if (ep.rTask == null) {
    return {
      status: "queued",
      reason: "Reward 评分尚未完成，技能流水线将在评分后启动",
      reasonKey: "tasks.skillReason.queued.rewardPending",
      reasonParams: null,
      linkedSkillId: null,
    };
  }
  if (ep.rTask <= R_NEGATIVE_FLOOR) {
    return {
      status: "skipped",
      reason: `任务评分为明显负分 (R=${ep.rTask.toFixed(2)})，视为反例`,
      reasonKey: "tasks.skillReason.skipped",
      reasonParams: { rTask: ep.rTask.toFixed(2) },
      linkedSkillId: null,
    };
  }
  if (ep.rTask < R_BELOW_THRESHOLD) {
    return {
      status: "not_generated",
      reason: `任务评分 R=${ep.rTask.toFixed(2)} 未达到沉淀阈值`,
      reasonKey: "tasks.skillReason.not_generated.belowThreshold",
      reasonParams: { rTask: ep.rTask.toFixed(2), threshold: R_BELOW_THRESHOLD.toFixed(2) },
      linkedSkillId: null,
    };
  }
  if (relatedPolicies.length === 0) {
    return {
      status: "not_generated",
      reason: "暂未归纳出 L2 经验",
      reasonKey: "tasks.skillReason.not_generated.noPolicy",
      reasonParams: null,
      linkedSkillId: null,
    };
  }
  const best = [...relatedPolicies].sort((a, b) => b.gain - a.gain)[0]!;
  const policyBucket = skillsByPolicy.get(best.id) ?? [];
  if (policyBucket.length > 0) {
    const active = policyBucket.find((s) => s.status !== "archived") ?? policyBucket[0]!;
    const isUpgraded = best.updatedAt > active.updatedAt;
    return {
      status: isUpgraded ? "upgraded" : "generated",
      reason: `技能「${active.name ?? active.id}」已从经验 ${best.id.slice(0, 8)} 结晶`,
      reasonKey: isUpgraded ? "tasks.skillReason.upgraded" : "tasks.skillReason.generated",
      reasonParams: { skillName: active.name ?? active.id, policyId: best.id.slice(0, 8) },
      linkedSkillId: active.id as SkillId,
    };
  }
  if (best.status !== "active") {
    return {
      status: "queued",
      reason: `经验 ${best.id.slice(0, 8)} 需要更多支撑任务`,
      reasonKey: "tasks.skillReason.queued.policyPending",
      reasonParams: { support: String(best.support ?? 0) },
      linkedSkillId: null,
    };
  }
  return {
    status: "queued",
    reason: `经验 ${best.id.slice(0, 8)} 已就绪`,
    reasonKey: "tasks.skillReason.queued.ready",
    reasonParams: { gain: best.gain.toFixed(2), support: String(best.support ?? 0) },
    linkedSkillId: null,
  };
}

/**
 * Produce a short content string from toolCalls when userText/agentText
 * are both empty (sub-steps after the first in a multi-tool turn).
 */
function summarizeToolCalls(
  toolCalls?: readonly { name?: string; output?: unknown }[] | null,
): string {
  if (!toolCalls || toolCalls.length === 0) return "";
  return toolCalls
    .map((tc) => {
      const name = tc.name ?? "tool";
      const out = typeof tc.output === "string"
        ? tc.output.slice(0, 200)
        : tc.output != null
        ? JSON.stringify(tc.output).slice(0, 200)
        : "";
      return out ? `[${name}] ${out}` : `[${name}]`;
    })
    .join("\n");
}

/**
 * Heuristic role inference for api_logs "memory_add" rows — mirrors
 * the legacy plugin's behaviour where each captured turn showed up
 * labelled `user` / `assistant` / `tool` on the Logs page.
 *
 * Priority: if the step carries userText (the user's query), label it
 * "user" even when toolCalls are present — this is the first sub-step
 * of a multi-tool turn and semantically represents the user request.
 */
function inferTurnRole(step: {
  userText?: string;
  agentText?: string;
  toolCalls?: readonly unknown[];
}): "user" | "assistant" | "tool" | "other" {
  const u = (step.userText ?? "").length;
  const a = (step.agentText ?? "").length;
  if (u > 0 && (step.toolCalls?.length ?? 0) > 0) return "user";
  if ((step.toolCalls?.length ?? 0) > 0) return "tool";
  if (u >= a && u > 0) return "user";
  if (a > 0) return "assistant";
  return "other";
}
