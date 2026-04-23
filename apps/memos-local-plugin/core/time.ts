/**
 * Centralized time helpers. The whole codebase reads `now()` rather than
 * touching `Date.now()` directly, so tests can monkey-patch the clock in one
 * place if needed.
 */

export type EpochMs = number;

/** Default wall-clock source. Swap with `setNow` for deterministic tests. */
let _now: () => EpochMs = () => Date.now();

export function now(): EpochMs {
  return _now();
}

/**
 * Override the clock source. Returns a restore function. Intended for tests:
 *
 * ```ts
 * const restore = setNow(() => 1_700_000_000_000);
 * try { ... } finally { restore(); }
 * ```
 */
export function setNow(fn: () => EpochMs): () => void {
  const previous = _now;
  _now = fn;
  return () => { _now = previous; };
}

/** Monotonic high-resolution clock (ms, fractional). Independent of `now()`. */
export function hrNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

/** Format a millisecond duration into a short human string ("12ms" / "1.2s" / "3m4s"). */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const abs = Math.abs(ms);
  if (abs < 1) return ms.toFixed(2) + "ms";
  if (abs < 1000) return Math.round(ms) + "ms";
  if (abs < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 2 : 1) + "s";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/** Convenience: ISO 8601 string for a given epoch ms (UTC). */
export function isoFromEpochMs(ms: EpochMs): string {
  return new Date(ms).toISOString();
}
