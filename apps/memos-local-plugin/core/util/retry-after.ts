/** Parse RFC 9110 Retry-After delay-seconds or HTTP-date into milliseconds. */
export const MAX_INLINE_RETRY_DELAY_MS = 30_000;
/** @deprecated Use MAX_INLINE_RETRY_DELAY_MS. */
export const MAX_RETRY_DELAY_MS = MAX_INLINE_RETRY_DELAY_MS;

export type RetryDeferReason =
  | "deadline_insufficient"
  | "retry_after_too_long";

export interface RetryPlanBase {
  backoffMs: number;
  delayMs: number;
  retryAfterMs: number | null;
  retryAt: number;
  source: "backoff" | "retry_after";
}

export type RetryPlan =
  | (RetryPlanBase & { action: "wait" })
  | (RetryPlanBase & { action: "defer"; reason: RetryDeferReason });

export interface RetryCooldown {
  retryAfterMs: number;
  retryAt: number;
  status: number;
}

export interface RetryDiagnosticDetails {
  retryAfterMs?: number;
  retryAt?: number;
  retryDecision?: "wait" | "defer" | "stop";
  retryReason?: string;
}

const retryCooldowns = new Map<string, RetryCooldown>();

export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    const delayMs = seconds * 1_000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(delayMs)
      ? delayMs
      : null;
  }
  // Retry-After only permits IMF-fixdate here. Keeping the shape strict avoids
  // JavaScript accepting ambiguous strings such as "1.5" as a legacy date.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

export function retryDelayMs(input: {
  attempt: number;
  baseMs: number;
  jitterMaxMs: number;
  retryAfterMs?: number | null;
  maxDelayMs?: number;
  random?: () => number;
}): number {
  const plan = planRetry({
    ...input,
    maxInlineDelayMs: input.maxDelayMs,
  });
  return plan.delayMs;
}

/**
 * Decide whether a retry can happen inline without violating Retry-After.
 *
 * Provider Retry-After values are never clamped downward. When the earliest
 * legal retry cannot fit the inline wait or request deadline, callers must
 * defer/fallback and carry retryAt into their recovery path.
 */
export function planRetry(input: {
  attempt: number;
  baseMs: number;
  jitterMaxMs: number;
  retryAfterMs?: number | null;
  maxInlineDelayMs?: number;
  deadlineAt?: number;
  nowMs?: number;
  random?: () => number;
}): RetryPlan {
  const nowMs = input.nowMs ?? Date.now();
  const random = input.random ?? Math.random;
  const jitter = Math.floor(random() * input.jitterMaxMs);
  const rawBackoff = input.baseMs * 2 ** Math.max(0, input.attempt - 1) + jitter;
  const maxInlineDelayMs = input.maxInlineDelayMs ?? MAX_INLINE_RETRY_DELAY_MS;
  const backoffMs = Math.min(rawBackoff, maxInlineDelayMs);
  const retryAfterMs = input.retryAfterMs ?? null;
  const delayMs = Math.max(backoffMs, retryAfterMs ?? 0);
  const retryAt = nowMs + delayMs;
  const source = retryAfterMs !== null && retryAfterMs >= backoffMs
    ? "retry_after" as const
    : "backoff" as const;
  const base: RetryPlanBase = {
    backoffMs,
    delayMs,
    retryAfterMs,
    retryAt,
    source,
  };

  if (retryAfterMs !== null && retryAfterMs > maxInlineDelayMs) {
    return { ...base, action: "defer", reason: "retry_after_too_long" };
  }
  if (input.deadlineAt !== undefined && retryAt > input.deadlineAt) {
    return { ...base, action: "defer", reason: "deadline_insufficient" };
  }
  return { ...base, action: "wait" };
}

export function retryCooldownKey(
  kind: "llm" | "embedding",
  provider: string,
  url: string,
  scope: string = "",
): string {
  return `${kind}\u0000${provider}\u0000${url}\u0000${scope}`;
}

/** Extend a provider cooldown monotonically; a shorter later response cannot weaken it. */
export function recordRetryCooldown(key: string, cooldown: RetryCooldown): void {
  const current = retryCooldowns.get(key);
  if (!current || cooldown.retryAt > current.retryAt) {
    retryCooldowns.set(key, { ...cooldown });
  }
}

export function getRetryCooldown(
  key: string,
  nowMs: number = Date.now(),
): RetryCooldown | null {
  const cooldown = retryCooldowns.get(key);
  if (!cooldown) return null;
  if (cooldown.retryAt <= nowMs) {
    retryCooldowns.delete(key);
    return null;
  }
  return { ...cooldown };
}

/** Test/runtime-reset hook; plugin shutdown does not need to await cooldown state. */
export function clearRetryCooldowns(): void {
  retryCooldowns.clear();
}

/** Copy only bounded, machine-readable retry fields from an error detail bag. */
export function extractRetryDiagnostics(
  details: Record<string, unknown> | undefined,
): RetryDiagnosticDetails {
  if (!details) return {};
  const diagnostic: RetryDiagnosticDetails = {};
  if (typeof details.retryAfterMs === "number" && Number.isFinite(details.retryAfterMs)) {
    diagnostic.retryAfterMs = details.retryAfterMs;
  }
  if (typeof details.retryAt === "number" && Number.isFinite(details.retryAt)) {
    diagnostic.retryAt = details.retryAt;
  }
  if (
    details.retryDecision === "wait"
    || details.retryDecision === "defer"
    || details.retryDecision === "stop"
  ) {
    diagnostic.retryDecision = details.retryDecision;
  }
  if (typeof details.retryReason === "string") {
    diagnostic.retryReason = details.retryReason;
  }
  return diagnostic;
}

/** Abortable retry wait so request cancellation and shutdown do not leave sleepers behind. */
export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (delayMs <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal ? abortReason(signal) : new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}
