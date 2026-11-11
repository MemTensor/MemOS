/**
 * `chatgpt` provider — runs MemOS LLM calls on the user's ChatGPT plan via
 * "Sign in with ChatGPT" (OpenAI Responses API), with automatic fallback to
 * the existing openai_compatible settings (OpenRouter) in the same `llm`
 * block.
 *
 * Sign in once (from the plugin folder): node scripts/chatgpt-login.mjs
 *
 * Endpoint: POST https://api.openai.com/v1/responses with store:false and
 * stream:true. Success only on `response.completed`. `temperature`,
 * `max_output_tokens` and system-role input items are not accepted on this
 * route, so system text goes into `instructions` and temperature/maxTokens
 * are ignored.
 *
 * Config (all optional except provider):
 *   llm:
 *     provider: chatgpt
 *     endpoint/apiKey/model: OpenRouter settings, used for fallback
 *     chatgpt:
 *       model: <slug from GET /v1/models>
 *       fallback: true            # default true
 *       tokenFile: <path>         # default ~/.config/memos-local/chatgpt-oauth.json
 *       reasoningEffort: low      # omitted unless set
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { ChatGptAuthError, CHATGPT_API_BASE, getAccessToken, type TokenOptions, type AccessToken } from "../chatgpt-auth.js";
import { decodeSse } from "../fetcher.js";
import { OpenAiLlmProvider } from "./openai.js";
import type {
  ChatGptProviderConfig,
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderName,
  LlmStreamChunk,
  LlmUsage,
  ProviderCallInput,
  ProviderCompletion,
} from "../types.js";

const RESPONSES_URL = `${CHATGPT_API_BASE}/responses`;
export const DEFAULT_CHATGPT_MODEL = "gpt-6.1-sol";

/** How long to skip ChatGPT after a failure of each kind (ms). */
export const PAUSE_MS = {
  usageLimit: 30 * 60_000,
  notEligible: 6 * 60 * 60_000,
  auth: 10 * 60_000,
} as const;

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const BACKOFF_MS = [1_000, 3_000];

/** Shared across provider instances in one process (llm / skillEvolver / l3). */
const pauseState = new Map<string, { until: number; reason: string }>();

export function resetChatGptPauseState(): void {
  pauseState.clear();
}

export class ChatGptFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "ChatGptFailure";
  }
}

export interface ChatGptDeps {
  fetchImpl?: typeof fetch;
  getToken?: (opts: TokenOptions) => Promise<AccessToken>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fallback?: LlmProvider;
}

interface StreamPiece {
  delta?: string;
  done?: { usage?: LlmUsage };
}

export class ChatGptLlmProvider implements LlmProvider {
  readonly name: LlmProviderName = "chatgpt";
  private readonly fetchImpl: typeof fetch;
  private readonly getToken: (opts: TokenOptions) => Promise<AccessToken>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fallbackProvider: LlmProvider;
  private jsonFormatUnsupported = false;

  constructor(deps: ChatGptDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.getToken = deps.getToken ?? getAccessToken;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fallbackProvider = deps.fallback ?? new OpenAiLlmProvider();
  }

  async complete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion> {
    const cg = chatgptConfig(ctx);
    const paused = this.pausedReason(cg);
    if (paused) return this.fallbackComplete(messages, opts, ctx, cg, paused, null);
    const start = this.now();
    try {
      let text = "";
      let usage: LlmUsage | undefined;
      for await (const piece of this.streamChatGpt(messages, opts, ctx, cg)) {
        if (piece.delta) text += piece.delta;
        if (piece.done) usage = piece.done.usage;
      }
      return { text, finishReason: "stop", usage, durationMs: this.now() - start };
    } catch (err) {
      return this.fallbackComplete(messages, opts, ctx, cg, null, err);
    }
  }

  async *stream(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): AsyncGenerator<LlmStreamChunk> {
    const cg = chatgptConfig(ctx);
    const paused = this.pausedReason(cg);
    if (paused) {
      yield* this.fallbackStream(messages, opts, ctx, cg, paused, null);
      return;
    }
    let emitted = false;
    try {
      for await (const piece of this.streamChatGpt(messages, opts, ctx, cg)) {
        if (piece.delta) {
          emitted = true;
          yield { delta: piece.delta, done: false };
        }
        if (piece.done) yield { delta: "", done: true, finishReason: "stop", usage: piece.done.usage };
      }
    } catch (err) {
      // Text already reached the caller: a silent switch would duplicate it.
      if (emitted) throw this.toMemosError(err, cg, ctx);
      yield* this.fallbackStream(messages, opts, ctx, cg, null, err);
    }
  }

  // ─── ChatGPT request ───────────────────────────────────────────────────────

  private async *streamChatGpt(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
    cg: ChatGptProviderConfig,
  ): AsyncGenerator<StreamPiece> {
    const tokenFile = cg.tokenFile && cg.tokenFile.length > 0 ? cg.tokenFile : undefined;
    let token = await this.getToken({ file: tokenFile });
    let refreshedAfter401 = false;
    let droppedJsonFormat = false;
    let attempt = 0;

    for (;;) {
      const body = this.buildBody(messages, opts, cg);
      const signal = mergeSignals(ctx.signal, ctx.config.timeoutMs, ctx.deadlineAt, this.now());
      let resp: Response;
      try {
        resp = await this.fetchImpl(RESPONSES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        const name = (err as Error)?.name ?? "Error";
        if (ctx.signal?.aborted) throw new ChatGptFailure("cancelled", null, "ChatGPT request was cancelled");
        if (name !== "TimeoutError" && attempt < BACKOFF_MS.length && this.fitsDeadline(ctx, BACKOFF_MS[attempt])) {
          await this.sleep(BACKOFF_MS[attempt++]);
          continue;
        }
        throw new ChatGptFailure(name === "TimeoutError" ? "timeout" : "network_error", null, `ChatGPT request failed (${name})`);
      }

      if (!resp.ok) {
        const failure = await readHttpFailure(resp);
        if (resp.status === 401 && !refreshedAfter401) {
          refreshedAfter401 = true;
          token = await this.getToken({ file: tokenFile, force: true, staleAccessToken: token.accessToken });
          continue;
        }
        if (
          failure.code === "subscription_sharing_unsupported_capability" &&
          opts.jsonMode &&
          !droppedJsonFormat &&
          !this.jsonFormatUnsupported &&
          (!failure.param || failure.param.startsWith("text"))
        ) {
          // JSON still enforced by the facade's prompt hint + parser.
          this.jsonFormatUnsupported = true;
          droppedJsonFormat = true;
          ctx.log.warn("chatgpt.json_format_unsupported", { param: failure.param });
          continue;
        }
        const retryable =
          RETRYABLE_STATUS.has(resp.status) &&
          failure.code !== "subscription_sharing_usage_limit_exceeded";
        if (retryable && attempt < BACKOFF_MS.length && this.fitsDeadline(ctx, BACKOFF_MS[attempt])) {
          await this.sleep(BACKOFF_MS[attempt++]);
          continue;
        }
        throw failure;
      }
      if (!resp.body) throw new ChatGptFailure("empty_body", resp.status, "ChatGPT returned an empty stream");

      yield* parseResponsesStream(resp.body);
      return;
    }
  }

  private buildBody(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    cg: ChatGptProviderConfig,
  ): Record<string, unknown> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    let input = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    let instructions = system;
    if (input.length === 0) {
      input = [{ role: "user", content: system }];
      instructions = "";
    }
    const body: Record<string, unknown> = {
      model: cg.model && cg.model.length > 0 ? cg.model : DEFAULT_CHATGPT_MODEL,
      input,
      store: false,
      stream: true,
    };
    if (instructions) body.instructions = instructions;
    if (opts.jsonMode && !this.jsonFormatUnsupported) body.text = { format: { type: "json_object" } };
    if (cg.reasoningEffort) body.reasoning = { effort: cg.reasoningEffort };
    return body;
  }

  // ─── Fallback & errors ─────────────────────────────────────────────────────

  private pausedReason(cg: ChatGptProviderConfig): string | null {
    const p = pauseState.get(pauseKey(cg));
    if (!p) return null;
    if (this.now() >= p.until) {
      pauseState.delete(pauseKey(cg));
      return null;
    }
    return p.reason;
  }

  private notePause(err: unknown, cg: ChatGptProviderConfig): void {
    const ms = pauseFor(err);
    if (ms > 0) pauseState.set(pauseKey(cg), { until: this.now() + ms, reason: failureCode(err) });
  }

  private async fallbackComplete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
    cg: ChatGptProviderConfig,
    pausedReason: string | null,
    err: unknown,
  ): Promise<ProviderCompletion> {
    if (err) this.notePause(err, cg);
    if (cg.fallback === false || ctx.signal?.aborted) {
      throw this.toMemosError(err ?? pausedErr(pausedReason), cg, ctx);
    }
    ctx.log.warn("chatgpt.fallback", {
      to: "openai_compatible",
      reason: pausedReason ? `paused:${pausedReason}` : failureCode(err),
      status: err instanceof ChatGptFailure ? err.status : undefined,
    });
    return this.fallbackProvider.complete(messages, opts, ctx);
  }

  private async *fallbackStream(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
    cg: ChatGptProviderConfig,
    pausedReason: string | null,
    err: unknown,
  ): AsyncGenerator<LlmStreamChunk> {
    if (err) this.notePause(err, cg);
    if (cg.fallback === false || ctx.signal?.aborted) {
      throw this.toMemosError(err ?? pausedErr(pausedReason), cg, ctx);
    }
    ctx.log.warn("chatgpt.fallback", {
      to: "openai_compatible",
      reason: pausedReason ? `paused:${pausedReason}` : failureCode(err),
      stream: true,
    });
    if (typeof this.fallbackProvider.stream === "function") {
      yield* this.fallbackProvider.stream(messages, opts, ctx);
      return;
    }
    const res = await this.fallbackProvider.complete(messages, opts, ctx);
    yield { delta: res.text, done: false };
    yield { delta: "", done: true, finishReason: res.finishReason, usage: res.usage };
  }

  private toMemosError(err: unknown, cg: ChatGptProviderConfig, ctx: LlmProviderCtx): MemosError {
    if (err instanceof MemosError) return err;
    const code = failureCode(err);
    const status = err instanceof ChatGptFailure ? err.status : null;
    const memosCode =
      code === "subscription_sharing_usage_limit_exceeded" || status === 429
        ? ERROR_CODES.LLM_RATE_LIMITED
        : code === "timeout" || code === "cancelled"
          ? ERROR_CODES.LLM_TIMEOUT
          : ERROR_CODES.LLM_UNAVAILABLE;
    ctx.log.warn("chatgpt.failed", { code, status });
    return new MemosError(memosCode, `chatgpt: ${code}${status ? ` (HTTP ${status})` : ""}`, {
      provider: "chatgpt",
      model: cg.model,
      status: status ?? undefined,
      chatgptCode: code,
    });
  }

  private fitsDeadline(ctx: LlmProviderCtx, delayMs: number): boolean {
    return ctx.deadlineAt === undefined || this.now() + delayMs < ctx.deadlineAt;
  }
}

// ─── Stream parsing ──────────────────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  code?: string;
  message?: string;
  param?: string;
  error?: { code?: string; message?: string; param?: string };
  response?: {
    status?: string;
    usage?: ResponsesUsage;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  };
}

export async function* parseResponsesStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamPiece> {
  let sawText = false;
  for await (const payload of decodeSse(body)) {
    if (payload === "[DONE]") break;
    let ev: ResponsesEvent;
    try {
      ev = JSON.parse(payload) as ResponsesEvent;
    } catch {
      continue; // keepalive / non-JSON line
    }
    switch (ev.type) {
      case "response.output_text.delta":
        if (ev.delta) {
          sawText = true;
          yield { delta: ev.delta };
        }
        break;
      case "response.completed": {
        if (!sawText) {
          const text = (ev.response?.output ?? [])
            .flatMap((o) => o.content ?? [])
            .filter((c) => c.type === "output_text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("");
          if (text) yield { delta: text };
        }
        yield { done: { usage: mapUsage(ev.response?.usage) } };
        return;
      }
      case "response.failed": {
        const code = ev.response?.error?.code ?? "unknown_error";
        throw new ChatGptFailure(code, null, `ChatGPT response failed (${code})`);
      }
      case "response.incomplete": {
        const reason = ev.response?.incomplete_details?.reason ?? "unknown";
        throw new ChatGptFailure(`incomplete:${reason}`, null, `ChatGPT response incomplete (${reason})`);
      }
      case "error": {
        const code = ev.code ?? ev.error?.code ?? "stream_error";
        throw new ChatGptFailure(code, null, `ChatGPT stream error (${code})`, ev.param ?? ev.error?.param);
      }
      default:
        break;
    }
  }
  throw new ChatGptFailure("stream_interrupted", null, "ChatGPT stream ended before response.completed");
}

function mapUsage(u: ResponsesUsage | undefined): LlmUsage | undefined {
  if (!u) return undefined;
  return { promptTokens: u.input_tokens, completionTokens: u.output_tokens, totalTokens: u.total_tokens };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function chatgptConfig(ctx: LlmProviderCtx): ChatGptProviderConfig {
  return ctx.config.chatgpt ?? {};
}

function pauseKey(cg: ChatGptProviderConfig): string {
  return cg.tokenFile && cg.tokenFile.length > 0 ? cg.tokenFile : "default";
}

function pausedErr(reason: string | null): ChatGptFailure {
  return new ChatGptFailure(reason ?? "paused", null, `ChatGPT paused (${reason ?? "unknown"})`);
}

function failureCode(err: unknown): string {
  if (err instanceof ChatGptFailure) return err.code;
  if (err instanceof ChatGptAuthError) return `auth:${err.kind}`;
  if (err instanceof MemosError) return err.code;
  return (err as Error)?.name ?? "unknown_error";
}

function pauseFor(err: unknown): number {
  if (err instanceof ChatGptAuthError) {
    return err.kind === "transient" || err.kind === "lock_timeout" ? 0 : PAUSE_MS.auth;
  }
  if (err instanceof ChatGptFailure) {
    if (err.code === "subscription_sharing_usage_limit_exceeded") return PAUSE_MS.usageLimit;
    if (err.code === "subscription_sharing_user_not_eligible") return PAUSE_MS.notEligible;
    if (err.status === 401 || err.status === 403) return PAUSE_MS.auth;
  }
  return 0;
}

async function readHttpFailure(resp: Response): Promise<ChatGptFailure> {
  let code = `http_${resp.status}`;
  let param: string | undefined;
  try {
    const j = (await resp.json()) as { error?: { code?: string; type?: string; param?: string } | string; code?: string };
    if (j && typeof j.error === "object" && j.error) {
      code = j.error.code ?? j.error.type ?? code;
      param = j.error.param ?? undefined;
    } else if (typeof j?.error === "string") {
      code = j.error;
    } else if (typeof j?.code === "string") {
      code = j.code;
    }
  } catch {
    /* non-JSON body: keep http_<status> */
  }
  return new ChatGptFailure(code, resp.status, `ChatGPT HTTP ${resp.status} (${code})`, param);
}

function mergeSignals(
  outer: AbortSignal | undefined,
  timeoutMs: number,
  deadlineAt: number | undefined,
  nowMs: number,
): AbortSignal {
  const budget = deadlineAt === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs, deadlineAt - nowMs));
  const signals: AbortSignal[] = [AbortSignal.timeout(budget)];
  if (outer) signals.push(outer);
  return AbortSignal.any(signals);
}
