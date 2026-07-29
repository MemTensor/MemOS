/**
 * Foreground-priority gate for the embedding layer.
 *
 * Problem (#2186): the local ONNX embedding provider runs CPU-bound inference
 * sequentially on the main thread. When the background capture pipeline is
 * embedding trace rows, a foreground retrieval request (turn.start) must wait
 * for the entire batch to finish — often exceeding the host's 8 s prefetch
 * timeout.
 *
 * Solution: a lightweight cooperative yield mechanism. Foreground callers
 * signal "I need the embedder NOW" via `enterForeground()`. The local provider
 * checks `isForegroundPending()` between individual texts in its batch loop
 * and yields the event loop (via `setImmediate`) so the foreground request can
 * proceed. Background callers wrap their work in `withBackground(fn)` which
 * automatically yields when foreground is pending.
 *
 * This is intentionally minimal — no queues, no worker threads, no interface
 * changes to `Embedder`. It simply gives the single-threaded ONNX inference a
 * cooperative scheduling point.
 */

let foregroundCount = 0;

/**
 * Signal that a foreground (user-facing) embedding request is about to start.
 * Returns a release function that MUST be called when the request completes.
 */
export function enterForeground(): () => void {
  foregroundCount++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      foregroundCount = Math.max(0, foregroundCount - 1);
    }
  };
}

/**
 * True when at least one foreground embedding request is pending.
 * Background batch loops should check this between items and yield.
 */
export function isForegroundPending(): boolean {
  return foregroundCount > 0;
}

/**
 * Yield the event loop if a foreground request is waiting.
 * Call this between expensive synchronous operations (e.g. between
 * individual ONNX inference calls in a batch).
 */
export async function yieldIfForegroundPending(): Promise<void> {
  if (foregroundCount > 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
