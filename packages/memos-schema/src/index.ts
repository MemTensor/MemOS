// ─── Identity & Isolation ───

export interface MemoryIdentity {
  /** Host agent system identifier, e.g. 'openclaw', 'openharness'. */
  app: string;
  /** Agent instance identifier within the host. */
  agent?: string;
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
}

export type IsolationMode = "isolated" | "shared" | "cross-app-read";

export interface IsolationPolicy {
  /**
   * - `isolated`: each app has its own database (default)
   * - `shared`: all apps share one database, search returns cross-app results
   * - `cross-app-read`: each app writes to its own namespace but can read from specified apps
   */
  mode: IsolationMode;
  /** Root directory for the database file. */
  stateDir: string;
  /** In `cross-app-read` mode, the list of other app identifiers whose memories are readable. */
  readableApps?: string[];
}

// ─── Write ───

export interface MemoryEventMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryEvent extends MemoryIdentity {
  timestamp: number;
  messages: MemoryEventMessage[];
  tags?: string[];
  cwd?: string;
  source?: Record<string, unknown>;
}

// ─── Query ───

export interface MemoryQuery {
  app: string;
  agent?: string;
  userId?: string;
  sessionId?: string;
  workspaceId?: string;
  query: string;
  topK?: number;
  cwd?: string;
}

// ─── Results ───

export interface MemoryHitChunk {
  text: string;
  score: number;
}

export interface MemoryHit {
  id: string;
  summary: string;
  score: number;
  timestamp: number;
  app: string;
  tags?: string[];
  chunks?: MemoryHitChunk[];
  originalExcerpt?: string;
  source?: {
    role: string;
    sessionKey: string;
    ts: number;
  };
}

export interface MemorySearchResult {
  hits: MemoryHit[];
  meta: {
    totalCandidates: number;
    usedMinScore: number;
    usedMaxResults: number;
    note?: string;
  };
}

// ─── Prompt Injection ───

export interface PromptInjection {
  /** Formatted markdown section containing recalled memories. */
  section: string;
  /** Number of memory hits that contributed to the section. */
  hitCount: number;
}

// ─── Adapter Context ───

export interface AdapterContext extends MemoryIdentity {
  latestUserPrompt?: string;
  conversationMessages?: Array<{ role: string; content: string }>;
  cwd?: string;
}

// ─── Core Config ───

export interface ProviderConfig {
  provider: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface EmbeddingConfig extends ProviderConfig {
  batchSize?: number;
  dimensions?: number;
}

export interface SummarizerConfig extends ProviderConfig {
  temperature?: number;
}

/**
 * Generic model provider interface. Host adapters inject their own implementation
 * (e.g. OpenClaw proxies host model requests, standalone mode calls APIs directly).
 */
export interface ModelProviderConfig {
  embed?(request: { texts: string[]; model?: string }): Promise<{ embeddings: number[][]; dimensions: number }>;
  complete?(request: { prompt: string; maxTokens?: number; temperature?: number; model?: string }): Promise<{ text: string }>;
}

export interface CoreConfig {
  stateDir: string;
  isolation?: IsolationPolicy;
  embedding?: EmbeddingConfig;
  summarizer?: SummarizerConfig;
  modelProvider?: ModelProviderConfig;
}

// ─── Bridge Protocol ───

export interface BridgeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: number;
  result?: unknown;
  error?: string;
}
