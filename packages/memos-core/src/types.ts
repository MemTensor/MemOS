// ─── Role & Message ───

export type Role = "user" | "assistant" | "system" | "tool";

export interface ConversationMessage {
  role: Role;
  content: string;
  timestamp: number;
  turnId: string;
  sessionKey: string;
  toolName?: string;
  owner?: string;
}

// ─── Chunk & Storage ───

export type DedupStatus = "active" | "duplicate" | "merged";

export interface Chunk {
  id: string;
  sessionKey: string;
  turnId: string;
  seq: number;
  role: Role;
  content: string;
  kind: ChunkKind;
  summary: string;
  embedding: number[] | null;
  taskId: string | null;
  skillId: string | null;
  owner: string;
  dedupStatus: DedupStatus;
  dedupTarget: string | null;
  dedupReason: string | null;
  mergeCount: number;
  lastHitAt: number | null;
  mergeHistory: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Task ───

export type TaskStatus = "active" | "completed" | "skipped";

export interface Task {
  id: string;
  sessionKey: string;
  title: string;
  summary: string;
  status: TaskStatus;
  owner: string;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
}

export type ChunkKind = "paragraph";

export interface ChunkRef {
  sessionKey: string;
  chunkId: string;
  turnId: string;
  seq: number;
}

// ─── Search / Recall ───

export type SearchHitOrigin = "local" | "local-shared" | "hub-memory" | "hub-remote";

export interface SearchHit {
  summary: string;
  original_excerpt: string;
  ref: ChunkRef;
  score: number;
  taskId: string | null;
  skillId: string | null;
  owner?: string;
  origin?: SearchHitOrigin;
  source: {
    ts: number;
    role: Role;
    sessionKey: string;
  };
}

export interface SkillSearchHit {
  skillId: string;
  name: string;
  description: string;
  owner: string;
  visibility: SkillVisibility;
  score: number;
  reason: string;
}

export interface SearchResult {
  hits: SearchHit[];
  meta: {
    usedMinScore: number;
    usedMaxResults: number;
    totalCandidates: number;
    note?: string;
  };
}

export interface TimelineEntry {
  excerpt: string;
  ref: ChunkRef;
  role: Role;
  ts: number;
  relation: "before" | "current" | "after";
}

export interface TimelineResult {
  entries: TimelineEntry[];
  anchorRef: ChunkRef;
}

export interface GetResult {
  content: string;
  ref: ChunkRef;
  source: {
    ts: number;
    role: Role;
    sessionKey: string;
  };
}

// ─── Candidate (internal) ───

export interface RankedCandidate {
  chunkId: string;
  ftsScore: number | null;
  vecScore: number | null;
  rrfScore: number;
  mmrScore: number;
  recencyScore: number;
  finalScore: number;
}

// ─── Provider ───

export type SummaryProvider =
  | "openai"
  | "openai_compatible"
  | "anthropic"
  | "gemini"
  | "azure_openai"
  | "bedrock"
  | "zhipu"
  | "siliconflow"
  | "deepseek"
  | "moonshot"
  | "bailian"
  | "cohere"
  | "mistral"
  | "voyage"
  | "openclaw";

export type EmbeddingProvider =
  | "openai"
  | "openai_compatible"
  | "gemini"
  | "azure_openai"
  | "cohere"
  | "mistral"
  | "voyage"
  | "local"
  | "openclaw";

export interface ProviderConfig {
  provider: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  temperature?: number;
  capabilities?: SharingCapabilities;
}

export interface SummarizerConfig extends ProviderConfig {
  provider: SummaryProvider;
}

export interface EmbeddingConfig extends ProviderConfig {
  provider: EmbeddingProvider;
  batchSize?: number;
  dimensions?: number;
  retry?: number;
}

// ─── Skill ───

export type SkillStatus = "active" | "archived" | "draft";
export type SkillUpgradeType = "create" | "refine" | "extend" | "fix";
export type TaskSkillRelation = "generated_from" | "evolved_from" | "applied_to";

export type SkillVisibility = "private" | "public";

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: number;
  status: SkillStatus;
  tags: string;
  sourceType: "task" | "manual";
  dirPath: string;
  installed: number;
  owner: string;
  visibility: SkillVisibility;
  qualityScore: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: number;
  content: string;
  changelog: string;
  changeSummary: string;
  upgradeType: SkillUpgradeType;
  sourceTaskId: string | null;
  metrics: string;
  qualityScore: number | null;
  createdAt: number;
}

export interface SkillGenerateOutput {
  skill_md: string;
  scripts: Array<{ filename: string; content: string }>;
  references: Array<{ filename: string; content: string }>;
  evals: Array<{ id: number; prompt: string; expectations: string[] }>;
}

export interface TaskSkillLink {
  taskId: string;
  skillId: string;
  relation: TaskSkillRelation;
  versionAt: number;
  createdAt: number;
}

// ─── Plugin Config ───

export interface SkillEvolutionConfig {
  enabled?: boolean;
  autoEvaluate?: boolean;
  minChunksForEval?: number;
  minConfidence?: number;
  maxSkillLines?: number;
  autoInstall?: boolean;
  autoRecallSkills?: boolean;
  autoRecallSkillLimit?: number;
  preferUpgradeExisting?: boolean;
  redactSensitiveInSkill?: boolean;
  /** Optional independent LLM config for skill evaluation/validation. Falls back to main summarizer if not set. */
  summarizer?: SummarizerConfig;
}

export interface TelemetryConfig {
  enabled?: boolean;
}

export type SharingRole = "hub" | "client";

export interface SharingCapabilities {
  hostEmbedding?: boolean;
  hostCompletion?: boolean;
  hostSkill?: boolean;
}

export interface HubModeConfig {
  port?: number;
  teamName?: string;
  teamToken?: string;
}

export interface ClientModeConfig {
  hubAddress?: string;
  userToken?: string;
  teamToken?: string;
  nickname?: string;
  pendingUserId?: string;
}

export interface SharingConfig {
  enabled?: boolean;
  role?: SharingRole;
  hub?: HubModeConfig;
  client?: ClientModeConfig;
  capabilities?: SharingCapabilities;
}

export interface MemosLocalConfig {
  summarizer?: SummarizerConfig;
  embedding?: EmbeddingConfig;
  storage?: {
    dbPath?: string;
  };
  recall?: {
    maxResultsDefault?: number;
    maxResultsMax?: number;
    minScoreDefault?: number;
    minScoreFloor?: number;
    rrfK?: number;
    mmrLambda?: number;
    recencyHalfLifeDays?: number;
    /** Cap vector search to this many most recent chunks. 0 = no cap (search all; may get slower with 200k+ chunks). If you set a cap for performance, use a large value (e.g. 200000–300000) so older memories are still in the window; FTS always searches all. */
    vectorSearchMaxChunks?: number;
  };
  dedup?: {
    similarityThreshold?: number;
  };
  capture?: {
    evidenceWrapperTag?: string;
  };
  skillEvolution?: SkillEvolutionConfig;
  telemetry?: TelemetryConfig;
  sharing?: SharingConfig;
  /** Hours of inactivity after which an active task is automatically finalized. 0 = disabled. Default 4. */
  taskAutoFinalizeHours?: number;
}

// ─── Defaults ───

export const DEFAULTS = {
  maxResultsDefault: 6,
  maxResultsMax: 20,
  minScoreDefault: 0.45,
  minScoreFloor: 0.35,
  rrfK: 60,
  mmrLambda: 0.7,
  recencyHalfLifeDays: 14,
  vectorSearchMaxChunks: 0,
  dedupSimilarityThreshold: 0.80,
  evidenceWrapperTag: "STORED_MEMORY",
  excerptMinChars: 200,
  excerptMaxChars: 500,
  getMaxCharsDefault: 2000,
  getMaxCharsMax: 8000,
  timelineWindowDefault: 2,
  localEmbeddingModel: "Xenova/all-MiniLM-L6-v2",
  localEmbeddingDimensions: 384,
  toolResultMaxChars: 2000,
  taskIdleTimeoutMs: 2 * 60 * 60 * 1000, // 2 hour gap → new task
  taskSummaryMaxTokens: 2000,
  skillEvolutionEnabled: true,
  skillAutoEvaluate: true,
  skillMinChunksForEval: 6,
  skillMinConfidence: 0.7,
  skillMaxLines: 400,
  skillAutoInstall: false,
  skillAutoRecall: true,
  skillAutoRecallLimit: 2,
  skillPreferUpgrade: true,
  skillRedactSensitive: true,
  taskAutoFinalizeHours: 4,
} as const;

// ─── Plugin Hooks (OpenClaw integration) ───

export interface PluginContext {
  stateDir: string;
  workspaceDir: string;
  config: MemosLocalConfig;
  log: Logger;
  openclawAPI?: OpenClawAPI;
}

export interface OpenClawAPI {
  embed(request: { texts: string[]; model?: string }): Promise<{ embeddings: number[][]; dimensions: number }>;
  complete(request: { prompt: string; maxTokens?: number; temperature?: number; model?: string }): Promise<{ text: string }>;
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}
