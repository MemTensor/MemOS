/**
 * Retryable network failure classification, shared by the LLM and embedding
 * HTTP fetchers (previously two hand-copied `isTransientError` regexes).
 *
 * Node's built-in fetch (undici) surfaces *every* network-level failure as
 * `TypeError: fetch failed` — the actual errno (`ECONNREFUSED`, `ECONNRESET`,
 * …) only appears on `err.cause`. Classifying by the top-level message alone
 * therefore never matches under undici, so real connectivity blips were
 * logged as terminal (`transient=false`) and never retried
 * (https://github.com/MemTensor/MemOS/issues/2379).
 *
 * We deliberately do NOT treat the bare `"fetch failed"` message as transient:
 * TLS certificate failures and policy rejections carry the same message and
 * must stay terminal. Classification keys off the cause chain's error *code*.
 */

const TRANSIENT_MESSAGE_RE = /ECONNRESET|EAI_AGAIN|socket hang up|timeout|ETIMEDOUT/i;

const TRANSIENT_CODE_RE =
  /^(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|UND_ERR|ABORT_ERR)$/i;

/** Cause-chain hops to inspect before giving up (defensive cycle bound). */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether `err` (or any of its `cause` links) looks like a retryable network
 * failure. Walks undici's cause chain; undici nests the errno-carrying error
 * under `TypeError: fetch failed`'s `cause`.
 */
export function isTransientNetworkError(err: unknown): boolean {
  for (
    let cur: unknown = err, depth = 0;
    cur instanceof Object && depth < MAX_CAUSE_DEPTH;
    cur = (cur as { cause?: unknown }).cause, depth++
  ) {
    const candidate = cur as { message?: unknown; code?: unknown };
    if (typeof candidate.message === "string" && TRANSIENT_MESSAGE_RE.test(candidate.message)) {
      return true;
    }
    if (typeof candidate.code === "string" && TRANSIENT_CODE_RE.test(candidate.code)) {
      return true;
    }
  }
  return false;
}
