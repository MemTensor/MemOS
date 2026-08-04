/** Parse RFC 9110 Retry-After delay-seconds or HTTP-date into milliseconds. */
export const MAX_RETRY_DELAY_MS = 30_000;

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
  const random = input.random ?? Math.random;
  const jitter = Math.floor(random() * input.jitterMaxMs);
  const exponential = input.baseMs * 2 ** Math.max(0, input.attempt - 1) + jitter;
  const requested = Math.max(exponential, input.retryAfterMs ?? 0);
  return Math.min(requested, input.maxDelayMs ?? MAX_RETRY_DELAY_MS);
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
