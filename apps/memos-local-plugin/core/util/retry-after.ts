/**
 * Parse the `Retry-After` HTTP response header per RFC 7231 §7.1.3.
 *
 * The value can be either:
 *   - a non-negative integer of seconds (delta-seconds), or
 *   - an HTTP-date (e.g. `Wed, 21 Oct 2025 07:28:00 GMT`).
 *
 * Returns the wait duration in milliseconds, capped to `capMs` to prevent a
 * hostile or buggy server from pinning the client indefinitely. Returns
 * `null` when the header is absent, malformed, or in the past (HTTP-date
 * already elapsed) — callers should fall back to their existing backoff
 * strategy. A value of `0` (delta-seconds) is valid and means "retry
 * immediately"; servers like GitHub do this briefly as a ratelimit window
 * expires.
 */
export function parseRetryAfterMs(resp: Response, capMs: number): number | null {
  const raw = resp.headers.get("retry-after");
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // delta-seconds: a non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const ms = seconds * 1000;
    return Math.min(ms, capMs);
  }

  // HTTP-date.
  const target = Date.parse(trimmed);
  if (Number.isNaN(target)) return null;
  const delta = target - Date.now();
  if (delta <= 0) return null;
  return Math.min(delta, capMs);
}
