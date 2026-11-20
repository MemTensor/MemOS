/**
 * Auto-recall session-key policy.
 *
 * Decides whether the `before_prompt_build` auto-recall hook should
 * short-circuit for the current OpenClaw session.
 *
 * Background: OpenClaw cron jobs use stable session keys of the form
 * `agent:<agentId>:cron:<jobId>`. Auto-recall has historically used the
 * cron prompt itself as the recall query, which means prior meta-discussion
 * about the cron (prompt tuning, debugging, rerun requests) was injected
 * back into the next scheduled run and contaminated its output. See
 * GitHub issue MemTensor/MemOS#1311.
 *
 * The helper is intentionally pure and lives outside the plugin entry so
 * it can be unit tested without spinning up the full plugin context.
 */

export interface AutoRecallExclusionConfig {
  /**
   * When true (default), skip auto-recall for any session whose key
   * contains a `cron` segment (`/(^|:)cron(:|$)/i`). Operators who rely on
   * cron-cross-turn memory recall can flip this to `false` to restore the
   * pre-1311 behaviour.
   */
  excludeCron?: boolean;
  /**
   * Optional list of additional regex strings tested against the raw
   * session key. Any match wins (OR semantics with `excludeCron`).
   * Invalid regex strings are ignored.
   */
  excludeSessionKeyPatterns?: string[];
}

const CRON_SEGMENT_RE = /(?:^|:)cron(?::|$)/i;

/**
 * Return `true` when the auto-recall hook should not run for this session.
 *
 * - Empty / missing `sessionKey` → returns `false` (no opinion; preserves
 *   behaviour for hosts that do not pass a session key).
 * - Cron session keys are skipped when `cfg?.excludeCron !== false`.
 *   The default behaviour (no config) is to skip.
 * - Any user-supplied regex in `cfg?.excludeSessionKeyPatterns` that
 *   matches the session key also forces a skip.
 */
export function shouldSkipAutoRecallForSession(
  sessionKey: string | undefined,
  cfg: AutoRecallExclusionConfig | undefined,
): boolean {
  if (!sessionKey) return false;

  const excludeCron = cfg?.excludeCron ?? true;
  if (excludeCron && CRON_SEGMENT_RE.test(sessionKey)) return true;

  const patterns = cfg?.excludeSessionKeyPatterns ?? [];
  for (const raw of patterns) {
    try {
      if (new RegExp(raw).test(sessionKey)) return true;
    } catch {
      // Invalid regex — silently ignore. Callers may log this at config
      // resolution time but the hook must not throw.
    }
  }

  return false;
}
