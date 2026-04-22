/**
 * HTTP helpers for LLM providers.
 *
 * Similar in spirit to `core/embedding/fetcher.ts`, but LLM calls differ:
 *   - Retries on 5xx / 429 / transient network errors with exponential backoff.
 *   - Timeouts are per-call, not per-request, so streaming can take minutes.
 *   - Errors are mapped to `llm_unavailable` / `llm_rate_limited` /
 *     `llm_timeout` — the client cares which one it is.
 *   - A small SSE decoder is provided for providers that return
 *     `text/event-stream` (openai_compatible, anthropic).
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmProviderLogger, LlmProviderName } from "./types.js";

export interface HttpPostOpts<TBody> {
  url: string;
  body: TBody;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
  provider: LlmProviderName;
  log: LlmProviderLogger;
  onRetry?: (attempt: number) => void;
}

/**
 * Single JSON POST with retry + timeout. For streaming, see `httpPostStream`.
 */
export async function httpPostJson<TResp>(opts: HttpPostOpts<unknown>): Promise<{
  json: TResp;
  status: number;
  durationMs: number;
}> {
  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt <= opts.maxRetries) {
    attempt++;
    const start = Date.now();
    try {
      const signal = mergeSignals(opts.signal, AbortSignal.timeout(opts.timeoutMs));
      const resp = await fetch(opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...opts.headers,
        },
        body: JSON.stringify(opts.body),
        signal,
      });
      const ms = Date.now() - start;

      if (!resp.ok) {
        const text = await safeText(resp);
        const transient = resp.status >= 500 || resp.status === 429;
        opts.log.warn("http.non_ok", {
          status: resp.status,
          attempt,
          transient,
          durationMs: ms,
        });
        if (transient && attempt <= opts.maxRetries) {
          opts.onRetry?.(attempt);
          await backoff(attempt);
          continue;
        }
        throw new MemosError(
          errCodeForStatus(resp.status),
          `HTTP ${resp.status} from ${opts.provider}`,
          { provider: opts.provider, url: opts.url, status: resp.status, body: text },
        );
      }

      const json = (await resp.json()) as TResp;
      opts.log.debug("http.ok", {
        status: resp.status,
        attempt,
        durationMs: ms,
      });
      return { json, status: resp.status, durationMs: ms };
    } catch (err) {
      lastErr = err;
      if (err instanceof MemosError) throw err;
      const transient = isTransientError(err);
      const timedOut = isTimeout(err);
      opts.log.warn("http.exception", {
        attempt,
        transient,
        timedOut,
        err: toErrDetail(err),
      });
      if ((transient || timedOut) && attempt <= opts.maxRetries) {
        opts.onRetry?.(attempt);
        await backoff(attempt);
        continue;
      }
      if (timedOut) {
        throw new MemosError(
          ERROR_CODES.LLM_TIMEOUT,
          `${opts.provider} timed out after ${opts.timeoutMs} ms`,
          { provider: opts.provider, url: opts.url, timeoutMs: opts.timeoutMs },
        );
      }
      throw new MemosError(
        ERROR_CODES.LLM_UNAVAILABLE,
        `${opts.provider} request failed: ${(err as Error).message ?? String(err)}`,
        { provider: opts.provider, url: opts.url },
      );
    }
  }

  throw new MemosError(
    ERROR_CODES.LLM_UNAVAILABLE,
    `Exhausted retries to ${opts.provider}`,
    {
      provider: opts.provider,
      url: opts.url,
      cause: lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
  );
}

/**
 * Open an HTTP POST and return the raw streaming body. The caller is
 * responsible for parsing SSE. No retries here — streaming is "either works
 * or you start over from scratch".
 */
export async function httpPostStream(opts: {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  provider: LlmProviderName;
  log: LlmProviderLogger;
}): Promise<Response> {
  const signal = mergeSignals(opts.signal, AbortSignal.timeout(opts.timeoutMs));
  const resp = await fetch(opts.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...opts.headers,
    },
    body: JSON.stringify(opts.body),
    signal,
  });
  if (!resp.ok) {
    const text = await safeText(resp);
    throw new MemosError(
      errCodeForStatus(resp.status),
      `HTTP ${resp.status} from ${opts.provider} (stream)`,
      { provider: opts.provider, url: opts.url, status: resp.status, body: text },
    );
  }
  if (!resp.body) {
    throw new MemosError(
      ERROR_CODES.LLM_UNAVAILABLE,
      `${opts.provider} returned empty streaming body`,
      { provider: opts.provider, url: opts.url },
    );
  }
  return resp;
}

/**
 * Parse a `text/event-stream` body into its raw `data:` payloads.
 * Yields each `data: …` payload as a string. Handles the "[DONE]" sentinel
 * common to OpenAI-shape providers.
 */
export async function* decodeSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE events are separated by blank lines (\n\n).
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload.length > 0) yield payload;
        }
      }
      idx = buf.indexOf("\n\n");
    }
  }
  // Flush whatever's left in buf.
  for (const line of buf.split("\n")) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload.length > 0) yield payload;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errCodeForStatus(status: number): "llm_rate_limited" | "llm_unavailable" {
  if (status === 429) return ERROR_CODES.LLM_RATE_LIMITED;
  return ERROR_CODES.LLM_UNAVAILABLE;
}

async function safeText(resp: Response): Promise<string | undefined> {
  try {
    return await resp.text();
  } catch {
    return undefined;
  }
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  if (/ECONNRESET|EAI_AGAIN|socket hang up/i.test(msg)) return true;
  return false;
}

function isTimeout(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return true;
    if ((err as { code?: string }).code === "ABORT_ERR") return true;
    if (/timeout|ETIMEDOUT/i.test(err.message ?? "")) return true;
  }
  return false;
}

async function backoff(attempt: number): Promise<void> {
  const base = 250;
  const jitter = Math.floor(Math.random() * 120);
  const ms = base * 2 ** (attempt - 1) + jitter;
  await new Promise((r) => setTimeout(r, ms));
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  if (a.aborted || b.aborted) ctrl.abort();
  a.addEventListener("abort", forward, { once: true });
  b.addEventListener("abort", forward, { once: true });
  return ctrl.signal;
}

function toErrDetail(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { value: String(e) };
}
