/**
 * Plain data-transfer types crossing the core ↔ adapter boundary.
 *
 * Every type here is JSON-serializable: no `Date`, no `Map`, no class
 * instances, no functions. Times are ms since epoch (UTC).
 */

// ─── Identifiers ──────────────────────────────────────────────────────────────

export type AgentKind = "openclaw" | "hermes" | string;

export type SessionId = string;
export type EpisodeId = string;
export type TraceId = string;
export type PolicyId = string;
export type WorldModelId = string;
export type SkillId = string;
export type FeedbackId = string;

// ─── Time / scoring ───────────────────────────────────────────────────────────

/** Millisecond UTC epoch. */
export type EpochMs = number;

/** Human-feedback signed reward in [-1, 1] (R_human). */
export type Reward = number;
/** Reflection-quality weight in [0, 1] (α_t). */
export type ReflectionAlpha = number;
/** Discounted backpropagated value (V_t). */
export type ValueScore = number;
/** Skill adoption rate (η). */
export type SkillEta = number;

// ─── Capture (single turn → trace) ────────────────────────────────────────────

export interface ToolCallDTO {
  name: string;
  input: unknown;
  output?: unknown;
  errorCode?: string;
  startedAt: EpochMs;
  endedAt: EpochMs;
  /**
   * LLM-native thinking emitted *before* the model decided to invoke this
   * tool — e.g. "I got an error from tool_1, let me try a different
   * approach". Populated by the adapter when the model interleaves
   * thinking blocks between tool calls. `undefined` for legacy data or
   * when no thinking preceded this particular call.
   *
   * Stored inside `tool_calls_json` (no schema migration needed).
   */
  thinkingBefore?: string;
}

export interface TurnInputDTO {
  agent: AgentKind;
  sessionId: SessionId;
  /** Optional pre-existing episodeId (for continued tasks). */
  episodeId?: EpisodeId;
  /** Free-form text the user said this turn. */
  userText: string;
  /** Anything the agent already decided before calling MemoryCore. */
  contextHints?: Record<string, unknown>;
  /** Wall-clock when the turn began. */
  ts: EpochMs;
}

export interface TurnResultDTO {
  agent: AgentKind;
  sessionId: SessionId;
  episodeId: EpisodeId;
  /** Free-form text the agent emitted. */
  agentText: string;
  /**
   * Raw model "thinking" blocks produced **by the LLM itself** this
   * turn (e.g. Claude extended thinking, pi-ai `ThinkingContent`). This
   * is user-facing reasoning belonging to the conversation log — it is
   * NOT the same as `reflection`, which is the MemOS plugin's own
   * post-hoc summary used for scoring. Concatenate multiple blocks
   * with `\n\n` if the model emitted several.
   */
  agentThinking?: string;
  /** Tools called this turn (in order). */
  toolCalls: ToolCallDTO[];
  /**
   * Optional MemOS-produced reflection (the plugin's summary of what
   * the model did, used to compute α + backprop V). NEVER displayed
   * in the conversation log — it is an internal scoring signal, not
   * part of the user↔agent exchange.
   */
  reflection?: string;
  /** Wall-clock when the turn ended. */
  ts: EpochMs;
}

// ─── Memory items ─────────────────────────────────────────────────────────────

export interface TraceDTO {
  id: TraceId;
  episodeId: EpisodeId;
  sessionId: SessionId;
  ts: EpochMs;
  userText: string;
  agentText: string;
  /**
   * Short LLM-generated summary of this trace. This is what the
   * Memories viewer surfaces as the primary row text. Null when the
   * trace was written before the Phase-3.5 summarizer was added
   * (migration 005) or when the summarizer failed open.
   */
  summary?: string | null;
  /** Tags applied by capture / the user. Empty when none. */
  tags?: string[];
  /**
   * Sharing state (migration 006). `null` = private/not shared.
   * Surfaces in the viewer as a pill on each row and controls the
   * "共享 / 取消共享" button label.
   */
  share?: {
    scope: "private" | "public" | "hub";
    target?: string | null;
    sharedAt?: EpochMs | null;
  } | null;
  toolCalls: ToolCallDTO[];
  /**
   * Raw LLM-produced thinking for this step (extended-thinking blocks
   * from the model). Belongs to the conversation log the user sees,
   * NOT to scoring. See `TurnResultDTO.agentThinking`.
   */
  agentThinking?: string | null;
  /**
   * MemOS-generated reflection used by the reward pipeline (α +
   * backprop). Stored so the viewer can show it in the trace drawer
   * under a distinct "Reflection" heading — it must NEVER appear in
   * the conversation log.
   */
  reflection?: string;
  /** Backpropagated value V_t, in roughly [-1, 1]. */
  value: ValueScore;
  /** Reflection alpha α_t, in [0, 1]. */
  alpha: ReflectionAlpha;
  /** Last-applied human reward R_human, in [-1, 1]. */
  rHuman?: Reward;
  /** Cached priority used for L2 candidate selection. */
  priority: number;
  /**
   * Stable group key shared by every L1 trace produced from the same
   * user message. Equal to the user turn's `ts` (epoch ms). The
   * viewer collapses rows with identical `(episodeId, turnId)` into
   * a single "one round = one memory" card; algorithm-side machinery
   * (V/α/L2/Tier 2/Decision Repair) ignores the field.
   */
  turnId: EpochMs;
}

/**
 * A single row from `api_logs` — the structured trail the Logs
 * viewer page renders. `inputJson` / `outputJson` are stored as JSON
 * text so different tools can evolve their shape independently; the
 * UI parses + renders per-tool templates.
 */
export interface ApiLogDTO {
  id: number;
  toolName: string;
  inputJson: string;
  outputJson: string;
  durationMs: number;
  success: boolean;
  calledAt: EpochMs;
}

export interface PolicyDTO {
  id: PolicyId;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  /** How many supporting episodes induced this policy. */
  support: number;
  /** Average ΔV across supporting traces. */
  gain: number;
  /** "candidate" until promoted, "active" once stable, "archived" once revoked. */
  status: "candidate" | "active" | "archived";
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /**
   * Sharing state (migration 009). `null` = private/not shared. Same
   * shape as {@link TraceDTO.share}.
   */
  share?: {
    scope: "private" | "public" | "hub";
    target?: string | null;
    sharedAt?: EpochMs | null;
  } | null;
  /**
   * Last user-driven edit through the viewer's edit modal. Distinct
   * from `updatedAt`, which the induction / feedback pipeline owns.
   */
  editedAt?: EpochMs;
  /**
   * Decision guidance attached to this policy by the feedback pipeline
   * (V7 §2.4.6). The two lists are kept flat on the DTO so the viewer
   * can render them as a categorised pane without reaching into nested
   * objects. Source of truth is the structured `decisionGuidance`
   * column on `policies` (migration 001). Empty arrays mean "no
   * guidance learned yet" — never undefined.
   */
  preference: string[];
  antiPattern: string[];
  /**
   * Episode ids that supplied supporting traces for this policy —
   * used by the viewer to render click-through chips from a policy
   * back to its source tasks.
   */
  sourceEpisodeIds: string[];
}

/**
 * One entry inside the V7 §1.1 (ℰ, ℐ, 𝒞) triple. Mirrors
 * `WorldModelStructureEntry` on the storage side; copied here so the
 * agent-contract surface stays self-contained (no peer import into
 * `core/types.ts`).
 */
export interface WorldModelStructureEntryDTO {
  /** Short label, e.g. `"src/components/"` or `"alpine → musl wheels"`. */
  label: string;
  /** Free-form explanation. */
  description: string;
  /**
   * Optional evidence — trace ids and / or policy ids that justified
   * this entry. The viewer renders click-through chips into the
   * Memories tab (for `tr_*`) or PoliciesView (for `po_*`) so users
   * can audit "why did the world model claim this?".
   */
  evidenceIds?: string[];
}

export interface WorldModelDTO {
  id: WorldModelId;
  title: string;
  /** Free-form prose summarizing structure/patterns/constraints. */
  body: string;
  /**
   * V7 §1.1 / §2.4.1 — structured (ℰ, ℐ, 𝒞) triple as generated by
   * `l3.abstraction`:
   *
   *   - environment (ℰ)  — topology facts ("X lives at Y")
   *   - inference   (ℐ)  — behavioural rules ("X causes Y")
   *   - constraints (𝒞)  — taboos ("don't do Z because …")
   *
   * Each entry carries optional `evidenceIds` — the trace / policy
   * ids that justified the entry. Surfaced separately from `body` so
   * the viewer can render entry-level evidence chips with
   * click-through.
   *
   * Always present; empty arrays simply mean "no entries in that
   * facet" (common — a world model can have only constraints, etc.).
   */
  structure: {
    environment: WorldModelStructureEntryDTO[];
    inference: WorldModelStructureEntryDTO[];
    constraints: WorldModelStructureEntryDTO[];
  };
  /** Associated PolicyIds the model abstracts. */
  policyIds: PolicyId[];
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /**
   * Lifecycle state (migration 009). `'archived'` rows are kept on
   * disk so the user can un-archive — distinct from a hard delete.
   * Defaults to `'active'` for legacy rows.
   */
  status: "active" | "archived";
  /** Sharing state (migration 009). `null` = private/not shared. */
  share?: {
    scope: "private" | "public" | "hub";
    target?: string | null;
    sharedAt?: EpochMs | null;
  } | null;
  /** Last user edit through the viewer's edit modal. */
  editedAt?: EpochMs;
}

export interface SkillDTO {
  id: SkillId;
  name: string;
  /** "candidate" while still on trial, then "active", then "archived". */
  status: "candidate" | "active" | "archived";
  /** Plain-text invocation guide injected at retrieval Tier-1. */
  invocationGuide: string;
  /**
   * V7 §2.4.6 — preference / anti-pattern lines distilled from past
   * failures + fixes. Empty arrays mean "no guidance yet". Surfaced
   * in the viewer drawer + folded into the rendered `invocationGuide`
   * so Tier-1 retrieval naturally injects it into the agent's prompt.
   *
   * Mirrors `SkillProcedure.decisionGuidance` from the storage layer;
   * surfaced separately on the DTO so frontends don't need to reach
   * into `procedureJson`.
   */
  decisionGuidance: { preference: string[]; antiPattern: string[] };
  /**
   * V7 §2.1 `evidence_anchors` — the L1 traces that justified this
   * skill at crystallisation time. The viewer renders click-through
   * chips into the Memories tab so users can audit "why did the agent
   * crystallise this skill?". Always present (default `[]`).
   */
  evidenceAnchors: TraceId[];
  /** Adoption rate, in [0, 1]. */
  eta: SkillEta;
  /** Independent positive episodes used to crystallize. */
  support: number;
  /** V_with − V_without across supporting traces. */
  gain: number;
  /** Source policy/world-model ids. */
  sourcePolicyIds: PolicyId[];
  sourceWorldModelIds: WorldModelId[];
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /**
   * Monotonic counter — starts at 1 on crystallisation and increments
   * every rebuild. Paired with `api_logs.skill_generate /
   * skill_evolve` rows on the viewer to render an evolution timeline.
   */
  version: number;
  /** Sharing state (migration 009). `null` = private/not shared. */
  share?: {
    scope: "private" | "public" | "hub";
    target?: string | null;
    sharedAt?: EpochMs | null;
  } | null;
  /** Last user edit through the viewer's edit modal. */
  editedAt?: EpochMs;
}

export interface EpisodeDTO {
  id: EpisodeId;
  sessionId: SessionId;
  startedAt: EpochMs;
  endedAt?: EpochMs;
  traceIds: TraceId[];
  /** Final task-level reward, if known. */
  rTask?: Reward;
}

/**
 * A lightweight episode row tailored for the viewer's task list —
 * includes enough metadata to render a clickable row (status, preview
 * text, turn count) without a second round trip.
 */
export interface EpisodeListItemDTO {
  id: EpisodeId;
  sessionId: SessionId;
  startedAt: EpochMs;
  endedAt?: EpochMs;
  status: "open" | "closed";
  /** Final task-level reward (post-reward), when known. */
  rTask?: Reward | null;
  /** Number of traces attached to this episode. */
  turnCount: number;
  /** First user text, truncated to 160 chars, for list preview. */
  preview?: string;
  /** Union of tags across the episode's traces (deduped, sorted). */
  tags?: string[];
  /**
   * Viewer-only: what happened in the skill pipeline for this
   * episode. Computed at read time from the episode / reward /
   * policy / skill state so the Tasks list can render a reason
   * badge without the user having to open the drawer.
   *
   * Mirrors the legacy plugin's `tasks.skill_status` field. Values:
   *   - `"queued"`       — capture done, reward/policy/skill still to run
   *   - `"generating"`   — a skill is mid-create (rare on reload)
   *   - `"generated"`    — a skill row cites a policy from this episode
   *   - `"upgraded"`     — an existing skill was updated by this episode
   *   - `"not_generated"`— pipeline decided not to crystallise (see reason)
   *   - `"skipped"`      — episode didn't run the pipeline at all
   *                       (abandoned / r<0 / no policy)
   *   - `null`           — unknown / pre-migration
   */
  skillStatus?:
    | "queued"
    | "generating"
    | "generated"
    | "upgraded"
    | "not_generated"
    | "skipped"
    | null;
  /** Free-form explanation of `skillStatus`. Shown on the row + drawer. */
  skillReason?: string | null;
  /** Skill id linked to this episode, when `skillStatus` is generated/upgraded. */
  linkedSkillId?: SkillId | null;
  /**
   * How the episode terminated — populated by `EpisodeManager`:
   *   - `"finalized"`  normal close
   *   - `"abandoned"`  hard-stopped (host aborted, session closed, etc)
   * Lets the UI render a proper status badge (completed / skipped /
   * failed) without guessing from `rTask`.
   */
  closeReason?: "finalized" | "abandoned" | null;
  /**
   * User-readable reason when `closeReason === "abandoned"`. Mirrors
   * the legacy plugin's Chinese skip-reason strings (e.g. "对话内容
   * 过少（2 条消息）..."). Always safe to show verbatim.
   */
  abandonReason?: string | null;
}

// ─── Feedback ─────────────────────────────────────────────────────────────────

export type FeedbackChannel = "explicit" | "implicit";
export type FeedbackPolarity = "positive" | "negative" | "neutral";

export interface FeedbackDTO {
  id: FeedbackId;
  ts: EpochMs;
  episodeId?: EpisodeId;
  traceId?: TraceId;
  channel: FeedbackChannel;
  polarity: FeedbackPolarity;
  magnitude: number;        // [0, 1]
  rationale?: string;       // user's free text or auto-summary
  raw?: unknown;            // adapter-specific raw payload
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export interface RetrievalQueryDTO {
  agent: AgentKind;
  sessionId?: SessionId;
  episodeId?: EpisodeId;
  query: string;
  /** Optional structured filters (e.g. tags). */
  filters?: Record<string, unknown>;
  /** Maximum items to return per tier (overrides config). */
  topK?: { tier1?: number; tier2?: number; tier3?: number };
}

export interface RetrievalHitDTO {
  tier: 1 | 2 | 3;
  /** Source memory id (skillId | traceId/episodeId | worldModelId). */
  refId: string;
  refKind: "skill" | "trace" | "episode" | "world-model";
  score: number;
  snippet: string;
}

export interface RetrievalResultDTO {
  query: RetrievalQueryDTO;
  hits: RetrievalHitDTO[];
  /** Final injected context (already MMR-ranked + de-duplicated). */
  injectedContext: string;
  /** Per-tier latency in ms. */
  tierLatencyMs: { tier1: number; tier2: number; tier3: number };
}

// ─── Retrieval triggers & injection packet (see ARCHITECTURE.md §4) ───────────

/** Why did this retrieval happen? Useful for logging / telemetry / debugging. */
export type RetrievalReason =
  | "turn_start"
  | "tool_driven"
  | "skill_invoke"
  | "sub_agent"
  | "decision_repair";

export interface TurnStartCtx {
  agent: AgentKind;
  sessionId: SessionId;
  episodeId?: EpisodeId;
  userText: string;
  /** Host-side hints, e.g. current working dir, role, sub-agent profile. */
  contextHints?: Record<string, unknown>;
  ts: EpochMs;
}

export interface ToolDrivenCtx {
  agent: AgentKind;
  sessionId: SessionId;
  episodeId?: EpisodeId;
  /** Which memory tool was called (memory_search / memory_timeline / …). */
  tool: string;
  /** The tool's input arguments verbatim. */
  args: Record<string, unknown>;
  ts: EpochMs;
}

export interface RepairCtx {
  agent: AgentKind;
  sessionId: SessionId;
  episodeId?: EpisodeId;
  /** Which tool has been failing. */
  failingTool: string;
  /** Recent failure count inside the current trigger window. */
  failureCount: number;
  /** The tool's last error code (if classified). */
  lastErrorCode?: string;
  ts: EpochMs;
}

export interface InjectionSnippet {
  refKind: "skill" | "trace" | "episode" | "world-model" | "preference" | "anti-pattern";
  refId: string;
  title?: string;
  body: string;
  score?: number;
}

/**
 * The packet the core returns to an adapter. The adapter decides how to splice
 * these into its host prompt shape (system message, tool results, memos section
 * header, etc.).
 */
export interface InjectionPacket {
  reason: RetrievalReason;
  /** Top of the packet — highest-priority items first. */
  snippets: InjectionSnippet[];
  /**
   * Pre-rendered single-string view, for adapters that want to inject as one
   * "memos_context" block without walking `snippets`.
   */
  rendered: string;
  /** Per-tier latency in ms (zeros for repair/skill-invoke). */
  tierLatencyMs: { tier1: number; tier2: number; tier3: number };
  /** Stable id so the same packet can be referenced by events / logs. */
  packetId: string;
  /** When this packet was produced. */
  ts: EpochMs;
  /**
   * Resolved session id — mirrors `turn.sessionId` if the adapter passed
   * one, otherwise the freshly-minted id the core opened for this turn.
   * Non-optional so adapters can always correlate to `onTurnEnd`.
   */
  sessionId: SessionId;
  /**
   * Resolved episode id for this turn. The core opens a new episode on
   * `turn_start` (or reopens an existing one under V7 §0.1 revision
   * semantics), so this is **always** a real id — never synthetic.
   */
  episodeId: EpisodeId;
  /**
   * Snippets the LLM-based relevance filter judged unrelated to this
   * turn's user query and dropped before `snippets` was finalised.
   * Populated only when retrieval is run with an LLM filter step; empty
   * otherwise. Surfaced so the Logs page can show "initial N → kept M"
   * instead of an opaque number.
   */
  droppedByLlm?: InjectionSnippet[];
}

// ─── Tool observation (for decision-repair signals) ───────────────────────────

export interface ToolOutcomeDTO {
  sessionId: SessionId;
  episodeId?: EpisodeId;
  tool: string;
  success: boolean;
  errorCode?: string;
  durationMs: number;
  ts: EpochMs;
}
