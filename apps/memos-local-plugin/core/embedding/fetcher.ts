/**
 * Tiny wrapper around global `fetch` with:
 *   - per-call timeout (AbortSignal.timeout)
 *   - retry on transient failure (5xx / 429 / network error)
 *   - structured error → MemosError(code=embedding_unavailable)
 *
 * Providers should never call `fetch` directly; go through `httpPostJson`.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { EmbeddingProviderName, ProviderLogger } from "./types.js";

export interface HttpPostOpts<TBody> {
  url: string;
  body: TBody;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  provider: EmbeddingProviderName;
  log: ProviderLogger;
}

export async function httpPostJson<TResp>(opts: HttpPostOpts<unknown>): Promise<TResp> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 2;
  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt <= maxRetries) {
    attempt++;
    const start = Date.now();
    try {
      const signal = mergeSignals(opts.signal, AbortSignal.timeout(timeoutMs));
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

      if (!resp.ok) {
        const text = await safeText(resp);
        const transient = resp.status >= 500 || resp.status === 429;
        opts.log.warn("http.non_ok", {
          url: opts.url,
          status: resp.status,
          attempt,
          transient,
          durationMs: Date.now() - start,
        });
        if (transient && attempt <= maxRetries) {
          await backoff(attempt);
          continue;
        }
        throw new MemosError(
          ERROR_CODES.EMBEDDING_UNAVAILABLE,
          `HTTP ${resp.status} from ${opts.provider}`,
          { provider: opts.provider, url: opts.url, status: resp.status, body: text },
        );
      }

      opts.log.debug("http.ok", {
        url: opts.url,
        status: resp.status,
        attempt,
        durationMs: Date.now() - start,
      });
      return (await resp.json()) as TResp;
    } catch (err) {
      lastErr = err;
      if (err instanceof MemosError) throw err;
      const transient = isTransientError(err);
      opts.log.warn("http.exception", {
        url: opts.url,
        attempt,
        transient,
        err: serializeErr(err),
        durationMs: Date.now() - start,
      });
      if (transient && attempt <= maxRetries) {
        await backoff(attempt);
        continue;
      }
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        `Network error calling ${opts.provider}: ${(err as Error).message ?? String(err)}`,
        { provider: opts.provider, url: opts.url },
      );
    }
  }

  throw new MemosError(
    ERROR_CODES.EMBEDDING_UNAVAILABLE,
    `Exhausted retries to ${opts.provider}`,
    {
      provider: opts.provider,
      url: opts.url,
      cause: lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
  );
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
  // Node fetch maps network errors to specific causes; abort with timeout is
  // also retriable once. We're conservative here.
  const msg = err.message ?? "";
  if (/timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up/i.test(msg)) return true;
  if ((err as { code?: string }).code === "ABORT_ERR") return true;
  return false;
}

async function backoff(attempt: number): Promise<void> {
  const base = 200;
  const jitter = Math.floor(Math.random() * 100);
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

function serializeErr(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return { name: e.name, message: e.message };
  }
  return { value: String(e) };
}
