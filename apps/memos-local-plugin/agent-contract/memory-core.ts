/**
 * The single facade exposed by the algorithm core.
 *
 * Adapters call these methods (TypeScript adapters import the implementation
 * directly; non-TS adapters dispatch via JSON-RPC method names defined in
 * `jsonrpc.ts`).
 *
 * Implementation lives in `core/pipeline/memory-core.ts`. Tests mock this
 * interface; SDK consumers depend only on this file.
 */

import type {
  AgentKind,
  ApiLogDTO,
  EpisodeId,
  EpisodeListItemDTO,
  FeedbackDTO,
  PolicyDTO,
  RetrievalQueryDTO,
  RetrievalResultDTO,
  SessionId,
  SkillDTO,
  SkillId,
  SubagentOutcomeDTO,
  ToolOutcomeDTO,
  TraceDTO,
  TurnInputDTO,
  TurnResultDTO,
  WorldModelDTO,
} from "./dto.js";
import type { CoreEvent } from "./events.js";
import type { LogRecord } from "./log-record.js";

// ─── Public lifecycle / status ────────────────────────────────────────────────

export interface CoreHealth {
  ok: boolean;
  version: string;
  uptimeMs: number;
  agent: AgentKind;
  paths: {
    home: string;
    config: string;
    db: string;
    skills: string;
    logs: string;
  };
  llm: ModelHealth;
  embedder: ModelHealth & { dim: number };
  /**
   * Dedicated skill-crystallization model. When the operator leaves
   * `skillEvolver.model` blank, we surface the main LLM model with
   * `inherited: true` so the viewer can label it as "inherits from LLM".
   * The health fields mirror the main LLM client when `inherited=true`.
   */
  skillEvolver: ModelHealth & { inherited: boolean };
}

/**
 * Per-model connectivity summary used by the viewer's Overview page.
 * `available` reflects whether the client is configured (non-null);
 * `lastOkAt` / `lastError` reflect the most recent **actual** call
 * outcome tracked by the runtime. A green dot means "called successfully
 * at least once and the last call was good"; red means "most recent
 * call failed" + the error text to surface in a tooltip.
 */
export interface ModelHealth {
  available: boolean;
  provider: string;
  model: string;
  lastOkAt: number | null;
  lastError: { at: number; message: string } | null;
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

export type Unsubscribe = () => void;

export interface MemoryCore {
  // ── lifecycle ──
  init(): Promise<void>;
  shutdown(): Promise<void>;
  health(): Promise<CoreHealth>;

  // ── session / episode ──
  openSession(input: { agent: AgentKind; sessionId?: SessionId }): Promise<SessionId>;
  closeSession(sessionId: SessionId): Promise<void>;
  openEpisode(input: {
    sessionId: SessionId;
    episodeId?: EpisodeId;
    /** Optional initial user text (for adapters that know it). */
    userMessage?: string;
  }): Promise<EpisodeId>;
  closeEpisode(episodeId: EpisodeId): Promise<void>;

  // ── pipeline (per turn) ──
  /** Called *before* the agent acts. Returns the context to inject. */
  onTurnStart(turn: TurnInputDTO): Promise<RetrievalResultDTO>;
  /** Called *after* the agent acts. Persists the trace, schedules induction, etc. */
  onTurnEnd(result: TurnResultDTO): Promise<{ traceId: string; episodeId: EpisodeId }>;
  /** Called when the user gives task-level feedback (or implicit signals fire). */
  submitFeedback(feedback: Omit<FeedbackDTO, "id" | "ts"> & { ts?: number }): Promise<FeedbackDTO>;
  /**
   * Record a tool outcome. Feeds decision-repair so failure bursts can
   * trigger targeted re-injection on the *next* turn. Non-blocking: the
   * call returns before repair runs and never throws on unknown sessions.
   */
  recordToolOutcome(outcome: ToolOutcomeDTO): void;
  /**
   * Record a parent-session delegation outcome. Subagent lifecycle hooks
   * usually carry task/result metadata, not a full child transcript, so this
   * appends the visible delegation task/result to the parent episode.
   */
  recordSubagentOutcome(
    outcome: SubagentOutcomeDTO,
  ): Promise<{ traceId: string; episodeId: EpisodeId }>;

  // ── memory queries ──
  searchMemory(query: RetrievalQueryDTO): Promise<RetrievalResultDTO>;
  getTrace(id: string): Promise<TraceDTO | null>;
  /**
   * Mutate a single trace's user-facing fields (role / summary /
   * body). Never touches algorithmic signals. Returns the updated
   * DTO (or null if the id is unknown).
   */
  updateTrace(
    id: string,
    patch: {
      summary?: string | null;
      userText?: string;
      agentText?: string;
      tags?: readonly string[];
    },
  ): Promise<TraceDTO | null>;
  /** Delete a trace by id (idempotent). Hard delete. */
  deleteTrace(id: string): Promise<{ deleted: boolean }>;
  /**
   * Bulk delete — takes an id list and returns how many rows were
   * actually removed. The viewer's "批量删除" uses this.
   */
  deleteTraces(ids: readonly string[]): Promise<{ deleted: number }>;
  /**
   * Update the sharing state for a trace. `scope = null` clears the
   * share. The core never talks to the Hub itself; the adapter /
   * viewer are responsible for the network call, then call this to
   * persist the resulting state.
   */
  shareTrace(
    id: string,
    share: {
      scope: "private" | "public" | "hub" | null;
      target?: string | null;
      sharedAt?: number | null;
    },
  ): Promise<TraceDTO | null>;
  getPolicy(id: string): Promise<PolicyDTO | null>;
  getWorldModel(id: string): Promise<WorldModelDTO | null>;
  /**
   * List L2 policies ("经验") — newest-first. The viewer uses this
   * for the Experiences panel.
   */
  listPolicies(input?: {
    status?: PolicyDTO["status"];
    limit?: number;
    offset?: number;
    q?: string;
  }): Promise<PolicyDTO[]>;
  /** Total policy rows matching the same filter (no limit/offset). */
  countPolicies(input?: {
    status?: PolicyDTO["status"];
    q?: string;
  }): Promise<number>;
  /**
   * List L3 world models ("世界环境知识") — newest-first.
   */
  listWorldModels(input?: {
    limit?: number;
    offset?: number;
    q?: string;
  }): Promise<WorldModelDTO[]>;
  /** Total world-model rows matching the same filter. */
  countWorldModels(input?: { q?: string }): Promise<number>;
  /** Transition a policy through candidate → active → archived. */
  setPolicyStatus(
    id: string,
    status: PolicyDTO["status"],
  ): Promise<PolicyDTO | null>;
  /** Hard-delete a policy row. */
  deletePolicy(id: string): Promise<{ deleted: boolean }>;
  /**
   * Append decision guidance (preference / anti-pattern lines) to a
   * policy's `@repair` block. Used by the viewer's PolicyDrawer for
   * manual guidance entry — real agents land here via the feedback
   * pipeline (`core/feedback/feedback.ts::attachRepairToPolicies`).
   *
   * Duplicates are de-duped; lines that were already present are a
   * no-op. Returns the updated DTO or `null` if the policy id is
   * unknown.
   */
  editPolicyGuidance(
    id: string,
    patch: { preference?: string[]; antiPattern?: string[] },
  ): Promise<PolicyDTO | null>;
  /** Hard-delete a world-model row. */
  deleteWorldModel(id: string): Promise<{ deleted: boolean }>;
  /**
   * Apply a sharing transition to a policy. Same semantics as
   * {@link shareTrace}: pass `scope=null` to clear.
   */
  sharePolicy(
    id: string,
    share: {
      scope: "private" | "public" | "hub" | null;
      target?: string | null;
      sharedAt?: number | null;
    },
  ): Promise<PolicyDTO | null>;
  /**
   * Apply a sharing transition to a world model. Same semantics as
   * {@link shareTrace}.
   */
  shareWorldModel(
    id: string,
    share: {
      scope: "private" | "public" | "hub" | null;
      target?: string | null;
      sharedAt?: number | null;
    },
  ): Promise<WorldModelDTO | null>;
  /**
   * User-driven content patch from the viewer's edit modal. Only
   * surfaces title / trigger / procedure / verification / boundary —
   * status, support, gain, vec stay owned by the induction pipeline.
   */
  updatePolicy(
    id: string,
    patch: {
      title?: string;
      trigger?: string;
      procedure?: string;
      verification?: string;
      boundary?: string;
    },
  ): Promise<PolicyDTO | null>;
  /**
   * User-driven world-model patch. Mutates only `title`, `body`, or
   * `status` (active ↔ archived).
   */
  updateWorldModel(
    id: string,
    patch: { title?: string; body?: string; status?: "active" | "archived" },
  ): Promise<WorldModelDTO | null>;
  /** Soft-archive a world model so it can be un-archived later. */
  archiveWorldModel(id: string): Promise<WorldModelDTO | null>;
  /** Reverse of {@link archiveWorldModel}. */
  unarchiveWorldModel(id: string): Promise<WorldModelDTO | null>;
  listEpisodes(input: { sessionId?: SessionId; limit?: number; offset?: number }): Promise<EpisodeId[]>;
  /**
   * Like `listEpisodes` but returns rich per-row metadata the viewer
   * needs to render its task list without a second round trip
   * (session id, status, turn count, first-turn preview).
   */
  listEpisodeRows(input?: {
    sessionId?: SessionId;
    limit?: number;
    offset?: number;
  }): Promise<EpisodeListItemDTO[]>;
  /** Total episode rows matching the same filter (no limit/offset). */
  countEpisodes(input?: { sessionId?: SessionId }): Promise<number>;
  timeline(input: { episodeId: EpisodeId }): Promise<TraceDTO[]>;
  /**
   * Reverse-chronological trace listing for the Memories viewer.
   *
   * Unlike `searchMemory`, this is a pure timeline query — no embedder,
   * no ranking, no cold-start guards. The viewer uses it to show the
   * user's recent memory entries (summary + metadata) even when
   * retrieval would otherwise return zero results (e.g. brand-new
   * installs, query mismatch, offline embedder).
   *
   * @param input.limit    default 50
   * @param input.offset   default 0
   * @param input.sessionId optional filter
   * @param input.q        optional case-insensitive substring filter
   *                       applied to `summary ?? userText`
   */
  listTraces(input?: {
    limit?: number;
    offset?: number;
    sessionId?: SessionId;
    q?: string;
    /**
     * When true, paginate by distinct `(episodeId, turnId)` groups so
     * one user turn (query + tool sub-steps + reply) counts as one
     * memory. Returns all traces belonging to the paginated turns.
     */
    groupByTurn?: boolean;
  }): Promise<TraceDTO[]>;
  /** Total trace rows matching the same filter (no limit/offset). */
  countTraces(input?: { sessionId?: SessionId; q?: string; groupByTurn?: boolean }): Promise<number>;

  /**
   * Paged listing of the rich api_logs table ({@link ApiLogDTO}).
   * Fuels the viewer's Logs page — shows every memory_search and
   * memory_add call with the full input/output JSON.
   */
  listApiLogs(input?: {
    toolName?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: ApiLogDTO[]; total: number }>;

  // ── skills ──
  listSkills(input?: { status?: SkillDTO["status"]; limit?: number }): Promise<SkillDTO[]>;
  /** Total skill rows matching the same filter (no limit). */
  countSkills(input?: { status?: SkillDTO["status"] }): Promise<number>;
  getSkill(id: SkillId): Promise<SkillDTO | null>;
  archiveSkill(id: SkillId, reason?: string): Promise<void>;
  /**
   * Hard-delete a skill row. Distinct from {@link archiveSkill}, which
   * keeps the row but flips its status. Idempotent.
   */
  deleteSkill(id: SkillId): Promise<{ deleted: boolean }>;
  /**
   * Re-activate a previously archived skill. Sets status back to
   * `'active'` and stamps `updatedAt = now`.
   */
  reactivateSkill(id: SkillId): Promise<SkillDTO | null>;
  /**
   * User-driven skill patch from the viewer's edit modal. Only the
   * narrowly user-facing fields are mutable (`name`, `invocationGuide`).
   */
  updateSkill(
    id: SkillId,
    patch: { name?: string; invocationGuide?: string },
  ): Promise<SkillDTO | null>;
  /** Apply a sharing transition to a skill. */
  shareSkill(
    id: SkillId,
    share: {
      scope: "private" | "public" | "hub" | null;
      target?: string | null;
      sharedAt?: number | null;
    },
  ): Promise<SkillDTO | null>;

  // ── config (for viewer settings tab) ──
  /**
   * Return the current resolved `config.yaml`, with sensitive fields
   * (api keys, tokens) masked as `"••••"`. Safe to hand to a browser.
   */
  getConfig(): Promise<Record<string, unknown>>;
  /**
   * Apply a partial patch to `config.yaml` (deep merge, preserve
   * comments). Returns the new masked config.
   */
  patchConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>>;

  // ── analytics (viewer dashboard) ──
  /**
   * Aggregate counts for the viewer's Analytics tab. `days` controls
   * the window the `dailyWrites` histogram covers.
   */
  metrics(input?: { days?: number }): Promise<{
    total: number;
    writesToday: number;
    sessions: number;
    embeddings: number;
    dailyWrites: Array<{ date: string; count: number }>;
    /** Skill counts + "tasks → skills" evolution rate. */
    skillStats: {
      total: number;
      active: number;
      candidate: number;
      archived: number;
      /** episodes that directly minted a skill / total episodes */
      evolutionRate: number;
    };
    /** L2 policy counts + mean gain across active rows. */
    policyStats: {
      total: number;
      active: number;
      candidate: number;
      archived: number;
      /** Arithmetic mean of `gain` across *active* policies. */
      avgGain: number;
      /** Average quality score; we reuse `policy.gain` as a proxy. */
      avgQuality: number;
    };
    worldModelCount: number;
    decisionRepairCount: number;
    /** One bucket per day for the last `days`, newest-last. */
    dailySkillEvolutions: Array<{ date: string; count: number }>;
    /** Most recent crystallisations; viewer uses this for the "最近进化事件" table. */
    recentEvolutions: Array<{
      ts: number;
      skillId: string;
      skillName: string;
      status: "candidate" | "active" | "archived";
      sourcePolicyIds: string[];
    }>;
  }>;

  // ── export / import (bundle) ──
  exportBundle(): Promise<{
    version: 1;
    exportedAt: number;
    traces: TraceDTO[];
    policies: PolicyDTO[];
    worldModels: WorldModelDTO[];
    skills: SkillDTO[];
  }>;
  importBundle(bundle: {
    version?: number;
    traces?: unknown[];
    policies?: unknown[];
    worldModels?: unknown[];
    skills?: unknown[];
  }): Promise<{ imported: number; skipped: number }>;

  // ── observability ──
  /** Subscribe to every CoreEvent the algorithm emits. Returns unsubscribe. */
  subscribeEvents(handler: (e: CoreEvent) => void): Unsubscribe;
  /**
   * Snapshot of the most-recent aggregated events (ring-buffered). The
   * SSE route replays these to clients on connect so the Overview
   * "实时活动" panel isn't empty on page reload.
   */
  getRecentEvents(): readonly CoreEvent[];
  /** Subscribe to every (post-redaction) LogRecord. Returns unsubscribe. */
  subscribeLogs(handler: (r: LogRecord) => void): Unsubscribe;
  /** Allow non-TS adapters to forward their own log records into our sinks. */
  forwardLog(record: LogRecord): void;
}
