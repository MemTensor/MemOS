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
  EpisodeRow,
  FeedbackRow,
  PolicyRow,
  SkillRow,
  TraceId,
  TraceRow,
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

  // 2. Providers (embedding + LLM) — nullable so we can run without them.
  // The LLM facade we build falls through to "local_only" when no remote
  // endpoint is configured, but we still catch construction errors so the
  // core boots headless when providers can't be reached at startup.
  let embedder = null as ReturnType<typeof createEmbedder> | null;
  let llm = null as ReturnType<typeof createLlmClient> | null;
  try {
    embedder = createEmbedder(config.embedding as never);
  } catch (err) {
    log.warn("embedder.unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    embedder = null;
  }
  try {
    llm = createLlmClient(config.llm as never);
  } catch (err) {
    log.warn("llm.unavailable", {
      err: err instanceof Error ? err.message : String(err),
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
        fallbackToHost: false,
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

  function ensureLive(): void {
    if (shutDown) {
      throw new MemosError(
        "already_shut_down",
        "memory-core is shut down",
      );
    }
  }

  // ─── Stale episode auto-finalize ──
  // Mirrors `memos-local-openclaw` ViewerServer.autoFinalizeStaleTasks().
  // Open episodes older than 4 hours (configurable via
  // `algorithm.session.mergeMaxGapMs * 2`) are abandoned so the Tasks
  // view shows them as completed/skipped rather than perpetually "active".
  const STALE_EPISODE_TIMEOUT_MS = Math.max(
    handle.config.algorithm.session.mergeMaxGapMs * 2,
    4 * 60 * 60 * 1000,
  );
  let lastStaleScan = 0;
  function autoFinalizeStaleTasks(): void {
    const nowMs = Date.now();
    if (nowMs - lastStaleScan < 30_000) return;
    lastStaleScan = nowMs;
    try {
      const openEpisodes = handle.repos.episodes.list({ status: "open", limit: 200 });
      if (openEpisodes.length === 0) return;
      for (const ep of openEpisodes) {
        const epAge = nowMs - (ep.endedAt ?? ep.startedAt);
        if (epAge > STALE_EPISODE_TIMEOUT_MS) {
          log.info("stale_episode.auto_abandon", {
            episodeId: ep.id,
            sessionId: ep.sessionId,
            ageMs: epAge,
            thresholdMs: STALE_EPISODE_TIMEOUT_MS,
          });
          try {
            handle.episodeManager.abandon(
              ep.id as import("../../agent-contract/dto.js").EpisodeId,
              `自动关闭：空闲 ${Math.round(epAge / 60_000)} 分钟（阈值 ${Math.round(STALE_EPISODE_TIMEOUT_MS / 60_000)} 分钟）`,
            );
          } catch {
            // Episode may have been finalized concurrently — safe to ignore.
          }
        }
      }
    } catch (err) {
      log.debug("stale_episode.scan_error", {
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

    // Any `status: "open"` row we see on boot is an orphan from a
    // previous unclean shutdown — the plugin host was SIGKILL'd, the
    // gateway was bootout'd, the process crashed mid-turn, etc. We
    // have no in-memory state to reconcile them against, so they'd
    // otherwise stay "激活" forever in the viewer even though no one
    // is working on them. Abandon them now with an explicit reason
    // so the Tasks list shows the right status on first load.
    //
    // We deliberately do NOT fire the reward/capture chain for these
    // rows — the orphan state means there's no completed assistant
    // turn to score against, and re-running capture on a mid-flight
    // episode would double-insert traces. `abandon()` flips the row
    // to `closed` + sets `closeReason: "abandoned"` without touching
    // trace_ids_json.
    try {
      const orphans = handle.repos.episodes.list({ status: "open", limit: 500 });
      if (orphans.length > 0) {
        log.info("init.orphan_episodes.close", { count: orphans.length });
        const endedAt = Date.now();
        for (const ep of orphans) {
          try {
            handle.repos.episodes.close(
              ep.id as import("../../agent-contract/dto.js").EpisodeId,
              endedAt,
            );
            // If the pipeline already scored this episode (rTask is set),
            // mark it as "finalized" — the chain ran to completion before
            // the crash, only the final status flip was lost. Blanket
            // "abandoned" would show "已跳过" for a task that produced
            // real knowledge + possibly a skill.
            const hasReward = ep.rTask != null;
            handle.repos.episodes.updateMeta(
              ep.id as import("../../agent-contract/dto.js").EpisodeId,
              hasReward
                ? {
                    closeReason: "finalized",
                    abandonReason: undefined,
                  }
                : {
                    closeReason: "abandoned",
                    abandonReason:
                      "插件上次未正常退出，启动时自动关闭未完成的任务",
                  },
            );
            log.info(hasReward ? "init.orphan.finalized" : "init.orphan.abandoned", {
              episodeId: ep.id,
              rTask: ep.rTask,
            });
          } catch (err) {
            log.debug("init.orphan_close.skipped", {
              episodeId: ep.id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
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
          content: (tc.userText || tc.agentText || "").slice(0, 400),
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
        writeApiLog(handle, log, "skill_generate", {
          phase: "started",
          policyId: evt.policyId,
        }, evt, 0, true);
      } else if (k === "skill.crystallized") {
        writeApiLog(handle, log, "skill_generate", {
          phase: "done",
          skillId: evt.skillId,
        }, evt, 0, true);
      } else if (k === "skill.rebuilt" || k === "skill.eta.updated" || k === "skill.archived") {
        writeApiLog(handle, log, "skill_evolve", {
          kind: k,
          skillId: (evt as { skillId?: string }).skillId,
        }, evt, 0, true);
      } else if (k === "skill.verification.failed" || k === "skill.failed") {
        writeApiLog(handle, log, "skill_generate", {
          phase: "failed",
          kind: k,
        }, evt, 0, false);
      }
    });

    // ─── L2 (经验) lifecycle → api_logs(policy_*) ─────────────────────
    handle.buses.l2.onAny((evt) => {
      const k = evt.kind;
      if (k === "l2.policy.induced") {
        writeApiLog(handle, log, "policy_generate", {
          phase: "induced",
          policyId: evt.policyId,
          title: evt.title,
        }, evt, 0, true);
      } else if (k === "l2.policy.updated") {
        writeApiLog(handle, log, "policy_evolve", {
          policyId: evt.policyId,
          status: evt.status,
        }, evt, 0, true);
      } else if (k === "l2.failed") {
        writeApiLog(handle, log, "policy_generate", {
          phase: "failed",
        }, evt, 0, false);
      }
    });

    // ─── L3 (领域认知) lifecycle → api_logs(world_model_*) ────────────
    handle.buses.l3.onAny((evt) => {
      const k = evt.kind;
      if (k === "l3.world-model.created") {
        writeApiLog(handle, log, "world_model_generate", {
          phase: "created",
          worldModelId: evt.worldModelId,
          title: evt.title,
        }, evt, 0, true);
      } else if (k === "l3.world-model.updated") {
        writeApiLog(handle, log, "world_model_evolve", {
          worldModelId: evt.worldModelId,
          title: evt.title,
        }, evt, 0, true);
      } else if (k === "l3.confidence.adjusted") {
        writeApiLog(handle, log, "world_model_evolve", {
          kind: "confidence.adjusted",
        }, evt, 0, true);
      } else if (k === "l3.failed") {
        writeApiLog(handle, log, "world_model_generate", {
          phase: "failed",
        }, evt, 0, false);
      }
    });

    // ─── Reward / task completion → api_logs(task_done | task_failed) ──
    // The reward pipeline scores each finished episode; that score is
    // what makes a task "completed" (R ≥ 0) or "failed" (R < 0) in the
    // viewer's Tasks panel.
    handle.buses.reward.onAny((evt) => {
      if (evt.kind === "reward.scored") {
        const ok = evt.rHuman >= 0;
        writeApiLog(handle, log, ok ? "task_done" : "task_failed", {
          episodeId: evt.episodeId,
          sessionId: evt.sessionId,
        }, {
          rHuman: evt.rHuman,
          source: evt.source,
        }, 0, ok);
      }
    });
  }

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
      // V7 overview card: fall back to the newest captured trace as
      // a proxy for "LLM + embedder were OK recently" when the live
      // `stats().lastOkAt` counter hasn't yet been populated in this
      // process. Every captured trace is proof that reflection / α
      // scoring (LLM) and summary embedding (embedder) both
      // succeeded at that moment — so reading the DB max ts gives a
      // correct, non-fabricated lower bound that survives plugin
      // restarts without misleading the user.
      llm: llmHealth(handle.llm, latestTraceTs()),
      embedder: embedderHealth(handle.embedder, latestTraceTs()),
      skillEvolver: resolveSkillEvolver(handle.config, handle.llm, latestTraceTs()),
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
  }): Promise<SessionId> {
    ensureLive();
    const snap = handle.sessionManager.openSession({
      id: input.sessionId,
      agent: input.agent,
      meta: {},
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
    // Capture is asynchronous — when the caller wants a `traceId` we
    // deterministically allocate one upstream, but the V1 contract just
    // returns the latest snapshot ids. We return the final trace id the
    // episode snapshot reports (or a synthetic turn id if nothing yet).
    const snap = outcome.episode;
    const turnCount = snap?.turnCount ?? 0;
    const traceIds = snap?.traceIds ?? [];
    const lastTraceId =
      traceIds.length > 0
        ? traceIds[traceIds.length - 1]!
        : `trace-${outcome.episodeId}-${turnCount}`;
    return {
      traceId: lastTraceId,
      episodeId: outcome.episodeId,
    };
  }

  async function submitFeedback(
    feedback: Omit<FeedbackDTO, "id" | "ts"> & { ts?: number },
  ): Promise<FeedbackDTO> {
    ensureLive();
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
      retrievalStats = {
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
      };

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
    return row ? traceRowToDTO(row) : null;
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
    return updated ? traceRowToDTO(updated) : null;
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
    return updated ? traceRowToDTO(updated) : null;
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

    // Legacy parity: auto-finalize stale open episodes when the task
    // list is fetched, matching `memos-local-openclaw` ViewerServer's
    // `autoFinalizeStaleTasks()`. Default threshold: 4 hours.
    autoFinalizeStaleTasks();

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

    // For each row, fetch a cheap first-trace preview (single DB query
    // per episode). We keep it O(N) because typical N ≤ 50; a joined
    // query would optimise this but adds nontrivial SQL. Fine for the
    // viewer's task list.
    const out = rows.map((r: EpisodeRow) => {
      const firstTraceId = r.traceIds[0];
      let preview: string | undefined;
      const tagSet = new Set<string>();
      if (firstTraceId) {
        const trace = handle.repos.traces.getById(firstTraceId as TraceId);
        if (trace) {
          const raw = (trace.userText ?? trace.agentText ?? "").replace(/\s+/g, " ").trim();
          if (raw) preview = raw.length > 160 ? raw.slice(0, 157) + "…" : raw;
          for (const t of trace.tags ?? []) tagSet.add(t);
        }
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
      const closeReasonRaw = meta.closeReason;
      const closeReason: "finalized" | "abandoned" | null =
        closeReasonRaw === "finalized" || closeReasonRaw === "abandoned"
          ? closeReasonRaw
          : null;
      const abandonReason =
        typeof meta.abandonReason === "string" ? meta.abandonReason : null;

      return {
        id: r.id,
        sessionId: r.sessionId,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? undefined,
        status: r.status,
        rTask: r.rTask,
        turnCount: deriveTurnCount(r),
        preview,
        tags: tagSet.size > 0 ? Array.from(tagSet).sort() : undefined,
        skillStatus: derivation.status,
        skillReason: derivation.reason,
        linkedSkillId: derivation.linkedSkillId,
        closeReason,
        abandonReason,
      };
    });
    return out as never;
  }

  async function timeline(input: {
    episodeId: EpisodeId;
  }): Promise<TraceDTO[]> {
    ensureLive();
    const rows = handle.repos.traces.list({
      episodeId: input.episodeId,
      limit: 500,
      newestFirst: false,
    });
    return rows.map(traceRowToDTO);
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
  }): Promise<number> {
    ensureLive();
    const needle = (input?.q ?? "").trim().toLowerCase();
    if (!needle) {
      return handle.repos.traces.count({ sessionId: input?.sessionId });
    }
    // q substring scan — mirror `listTraces`. Walk all matching
    // traces from the repo (no limit) and apply the same filter.
    const rows = handle.repos.traces.list({ sessionId: input?.sessionId });
    return rows.filter((r) => {
      const hay = ((r.summary ?? "") + "\n" + r.userText + "\n" + r.agentText).toLowerCase();
      return hay.includes(needle);
    }).length;
  }

  async function listTraces(input?: {
    limit?: number;
    offset?: number;
    sessionId?: SessionId;
    q?: string;
  }): Promise<TraceDTO[]> {
    ensureLive();
    const limit = Math.max(1, Math.min(500, input?.limit ?? 50));
    const offset = Math.max(0, input?.offset ?? 0);
    const needle = (input?.q ?? "").trim().toLowerCase();
    if (!needle) {
      const rows = handle.repos.traces.list({
        sessionId: input?.sessionId,
        limit,
        offset,
      });
      return rows.map(traceRowToDTO);
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
      const hay = ((r.summary ?? "") + "\n" + r.userText + "\n" + r.agentText).toLowerCase();
      return hay.includes(needle);
    });
    return filtered.slice(offset, offset + limit).map(traceRowToDTO);
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

  async function getSkill(id: SkillId): Promise<SkillDTO | null> {
    ensureLive();
    const row = handle.repos.skills.getById(id);
    return row ? skillRowToDTO(row) : null;
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

    return {
      total: traces.length,
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
    const traces = handle.repos.traces.list({ limit: 100_000 }).map(traceRowToDTO);
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
          vec: null,
          createdAt: dto.createdAt ?? Date.now(),
          updatedAt: dto.updatedAt ?? Date.now(),
        } as PolicyRow);
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
          sourcePolicyIds: dto.sourcePolicyIds ?? [],
          sourceWorldModelIds: dto.sourceWorldModelIds ?? [],
          procedureJson: {},
          vec: null,
          createdAt: dto.createdAt ?? Date.now(),
          updatedAt: dto.updatedAt ?? Date.now(),
          version: dto.version ?? 1,
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

// ─── Row → DTO mappers ───────────────────────────────────────────────────────

export function traceRowToDTO(row: TraceRow): TraceDTO {
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
    turnId: row.turnId,
  };
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
    sourcePolicyIds: row.sourcePolicyIds,
    sourceWorldModelIds: row.sourceWorldModelIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version ?? 1,
    share: row.share ?? null,
    editedAt: row.editedAt ?? undefined,
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
function llmHealth(
  llm: PipelineHandle["llm"],
  fallbackTs: number | null,
): CoreHealth["llm"] {
  if (!llm) {
    return {
      available: false,
      provider: "none",
      model: "",
      lastOkAt: null,
      lastError: null,
    };
  }
  const s = llm.stats();
  return {
    available: true,
    provider: llm.provider,
    model: llm.model,
    // Prefer the live counter (most-recent call in this process).
    // Fall back to `fallbackTs` — the newest trace timestamp — so the
    // Overview card shows "connected" across plugin restarts as long
    // as there's proof of a successful call on disk.
    lastOkAt: s.lastOkAt ?? fallbackTs,
    lastError: s.lastError,
  };
}

function embedderHealth(
  embedder: PipelineHandle["embedder"],
  fallbackTs: number | null,
): CoreHealth["embedder"] {
  if (!embedder) {
    return {
      available: false,
      provider: "none",
      model: "",
      dim: 0,
      lastOkAt: null,
      lastError: null,
    };
  }
  const s = embedder.stats();
  return {
    available: true,
    provider: embedder.provider,
    model: embedder.model,
    dim: embedder.dimensions,
    lastOkAt: s.lastOkAt ?? fallbackTs,
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
    return {
      available: true,
      provider: evolver?.provider ?? "",
      model: own,
      inherited: false,
      // Skill evolver uses its own LlmClient instance when the operator
      // overrides the model. Today we don't expose that client through
      // the pipeline handle, so status reporting follows the shared LLM
      // while we keep the plumbing minimal.
      lastOkAt: llm?.stats().lastOkAt ?? fallbackTs,
      lastError: llm?.stats().lastError ?? null,
    };
  }
  const fallback = llmHealth(llm, fallbackTs);
  return {
    available: fallback.available,
    provider: fallback.provider,
    model: fallback.model,
    inherited: true,
    lastOkAt: fallback.lastOkAt,
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
 * Derive a human-readable skill-crystallisation status for an
 * episode ("task") from the raw episode row + its related policies /
 * skills. Mirrors the legacy `tasks.skill_status` / `skill_reason`
 * fields so the Tasks page can show the user *why* a completed task
 * produced no skill.
 *
 * Order matters: we return the first matching branch.
 */
/**
 * Derive a meaningful "turn count" for the viewer's task list.
 *
 * In the new project a "trace" represents a complete user→assistant
 * exchange (1 trace = 1 full turn). So `traceIds.length` of 1 means
 * there IS an assistant reply. The old project counted individual
 * messages (user + assistant + tool = separate chunks), so "2" meant
 * one user + one assistant.
 *
 * To keep the frontend's `turnCount` semantics consistent with how the
 * old project used it (and how the viewer renders it):
 *   - Each trace counts as 2 turns (user + assistant).
 *   - Open episodes with no traces yet get at least 1 (user sent).
 *   - This way `turnCount < 2` correctly means "no assistant reply yet".
 */
export function deriveTurnCount(r: EpisodeRow): number {
  if (r.traceIds.length > 0) return r.traceIds.length * 2;
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
  linkedSkillId: SkillId | null;
} {
  if (ep.status === "open") {
    return { status: "queued", reason: "任务仍在进行中，技能流水线尚未启动", linkedSkillId: null };
  }
  if (ep.rTask == null) {
    return {
      status: "queued",
      reason: "Reward 评分尚未完成，技能流水线将在评分后启动",
      linkedSkillId: null,
    };
  }
  if (ep.rTask <= R_NEGATIVE_FLOOR) {
    return {
      status: "skipped",
      reason: `任务评分为明显负分 (R=${ep.rTask.toFixed(2)})，视为反例；不会沉淀出新的 L2 经验或技能，但原始 L1 轨迹会作为反面教材保留，在后续 Decision Repair 中生成 anti-pattern 规避下次同类错误`,
      linkedSkillId: null,
    };
  }
  if (ep.rTask < R_BELOW_THRESHOLD) {
    return {
      status: "not_generated",
      reason: `任务评分 R=${ep.rTask.toFixed(2)} 未达到沉淀阈值 (≥ ${R_BELOW_THRESHOLD.toFixed(2)})——对话本身正常，只是还不够强到能泛化成 L2 经验；多做几个相似任务后会自动积累`,
      linkedSkillId: null,
    };
  }
  if (relatedPolicies.length === 0) {
    return {
      status: "not_generated",
      reason:
        "暂未归纳出 L2 经验——单个任务无法跨任务泛化；需要至少 2 个相似任务（minEpisodesForInduction），且 V 值 ≥ 0.1 才能触发 L2 诱导，之后支撑 ≥ 3 个相似任务才会结晶为技能",
      linkedSkillId: null,
    };
  }
  const best = [...relatedPolicies].sort((a, b) => b.gain - a.gain)[0]!;
  const policyBucket = skillsByPolicy.get(best.id) ?? [];
  if (policyBucket.length > 0) {
    const active = policyBucket.find((s) => s.status !== "archived") ?? policyBucket[0]!;
    return {
      status: best.updatedAt > active.updatedAt ? "upgraded" : "generated",
      reason: `技能「${active.name ?? active.id}」已从经验 ${best.id.slice(0, 8)} 结晶`,
      linkedSkillId: active.id as SkillId,
    };
  }
  if (best.status !== "active") {
    return {
      status: "queued",
      reason: `经验 ${best.id.slice(0, 8)} 状态为 ${best.status}——需要更多支撑任务才能结晶为技能（当前 support=${best.support ?? 0}，需 ≥3）`,
      linkedSkillId: null,
    };
  }
  return {
    status: "queued",
    reason: `经验 ${best.id.slice(0, 8)} 已就绪（gain=${best.gain.toFixed(2)}，support=${best.support ?? 0}），技能结晶将在下次 reward 评分后自动触发`,
    linkedSkillId: null,
  };
}

/**
 * Heuristic role inference for api_logs "memory_add" rows — mirrors
 * the legacy plugin's behaviour where each captured turn showed up
 * labelled `user` / `assistant` / `tool` on the Logs page.
 */
function inferTurnRole(step: {
  userText?: string;
  agentText?: string;
  toolCalls?: readonly unknown[];
}): "user" | "assistant" | "tool" | "other" {
  if ((step.toolCalls?.length ?? 0) > 0) return "tool";
  const u = (step.userText ?? "").length;
  const a = (step.agentText ?? "").length;
  if (u >= a && u > 0) return "user";
  if (a > 0) return "assistant";
  return "other";
}
