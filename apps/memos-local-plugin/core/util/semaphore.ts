export interface Semaphore {
  acquire(signal?: AbortSignal): Promise<() => void>;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createSemaphore(max: number): Semaphore {
  const limit = Math.max(1, Math.floor(max));
  let current = 0;
  const waiters: Waiter[] = [];

  return {
    async acquire(signal?: AbortSignal) {
      if (signal?.aborted) throw abortError(signal);
      if (current < limit) {
        current++;
        return release;
      }
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal };
        if (signal) {
          waiter.onAbort = () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(abortError(signal));
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        waiters.push(waiter);
      });
    },
  };

  function release() {
    current = Math.max(0, current - 1);
    const next = waiters.shift();
    if (!next) return;
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    current++;
    next.resolve(release);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("semaphore wait aborted", "AbortError");
}
