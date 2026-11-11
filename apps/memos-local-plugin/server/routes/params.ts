/**
 * Upper bound for a page size taken from UNTRUSTED input (HTTP query
 * params, agent tool args). Storage-level `clampLimit` honors explicit
 * limits up to `MAX_QUERY_LIMIT` for trusted in-process bulk reads
 * (#2401), so every route that forwards a caller-supplied `limit` into a
 * core/repo list call must cap it here first. 500 matches the effective
 * ceiling these endpoints had before that change.
 */
export const MAX_HTTP_PAGE_LIMIT = 500;

/**
 * Parse a `limit` query parameter into a safe page size.
 *
 * - missing / non-numeric / non-positive → `fallback` (50 by default)
 * - values above `MAX_HTTP_PAGE_LIMIT` are clamped to it
 */
export function parseLimitParam(
  raw: string | null,
  fallback = 50,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), MAX_HTTP_PAGE_LIMIT);
}
