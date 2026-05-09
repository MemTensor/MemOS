/**
 * Race a promise against a timeout. Resolves to `null` on timeout instead of
 * rejecting — clean fail-open semantics for best-effort work like auto-recall
 * where a slow LLM should never block the critical path (#1452).
 *
 * The underlying promise is NOT cancelled (we can't cancel a fetch from here);
 * we just stop waiting on it. Caller must treat the returned `null` as "give
 * up, proceed without this result".
 *
 * @param p     The promise to race.
 * @param ms    Timeout in milliseconds. Non-positive = no timeout (returns `p`).
 * @param label Short label for the warn log on timeout.
 * @param log   Optional logger; logs a warning when the timeout fires.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  log?: { warn: (msg: string) => void },
): Promise<T | null> {
  if (!Number.isFinite(ms) || ms <= 0) return p as Promise<T | null>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log?.warn(`${label}: timed out after ${ms}ms; falling back`);
      resolve(null);
    }, ms);
    // Don't keep the event loop alive solely for this timer.
    if (typeof (timer as any)?.unref === "function") (timer as any).unref();
  });
  return Promise.race<T | null>([
    p.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    timeout,
  ]);
}
