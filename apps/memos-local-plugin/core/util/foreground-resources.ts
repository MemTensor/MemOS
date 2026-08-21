import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type {
  EmbedCallOptions,
  Embedder,
  EmbedInput,
  EmbeddingSettledResult,
} from "../embedding/types.js";
import type { EmbeddingVector } from "../types.js";

export type ResourcePriority = "foreground" | "background";

export interface ForegroundResources {
  readonly shutdownSignal: AbortSignal;
  /** Combine a request signal with the pipeline lifecycle signal. */
  signalFor(signal?: AbortSignal): AbortSignal;
  /** Mark the complete turn.start path as foreground work. Idempotent release. */
  enterForeground(): () => void;
  /** Background LLM work waits here before acquiring its existing semaphore. */
  waitForBackground(signal?: AbortSignal): Promise<void>;
  /** Priority-aware, non-preemptive embedding admission. */
  acquireEmbedding(
    priority: ResourcePriority,
    signal?: AbortSignal,
  ): Promise<() => void>;
  /** Reject queued work and cancel provider calls before pipeline drain. */
  shutdown(reason?: string): void;
}

export interface ForegroundResourceOptions {
  embeddingConcurrency?: number;
  /** Prevent background starvation during a sustained foreground stream. */
  maxForegroundBurst?: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface BackgroundWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createForegroundResources(
  options: ForegroundResourceOptions = {},
): ForegroundResources {
  const capacity = Math.max(1, Math.floor(options.embeddingConcurrency ?? 1));
  const maxForegroundBurst = Math.max(
    1,
    Math.floor(options.maxForegroundBurst ?? 8),
  );
  const embeddingWaiters: Record<ResourcePriority, Waiter[]> = {
    foreground: [],
    background: [],
  };
  const backgroundWaiters: BackgroundWaiter[] = [];
  let embeddingInUse = 0;
  let foregroundActive = 0;
  let foregroundBurst = 0;
  const shutdownController = new AbortController();

  function signalFor(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, shutdownController.signal])
      : shutdownController.signal;
  }

  function abortError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("resource wait aborted", "AbortError");
  }

  function removeAbortListener(waiter: Waiter | BackgroundWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  function nextEmbeddingWaiter(): {
    priority: ResourcePriority;
    waiter: Waiter;
  } | null {
    const foreground = embeddingWaiters.foreground;
    const background = embeddingWaiters.background;
    if (
      background.length > 0 &&
      (foreground.length === 0 || foregroundBurst >= maxForegroundBurst)
    ) {
      return { priority: "background", waiter: background.shift()! };
    }
    if (foreground.length > 0) {
      return { priority: "foreground", waiter: foreground.shift()! };
    }
    if (background.length > 0) {
      return { priority: "background", waiter: background.shift()! };
    }
    return null;
  }

  function drainEmbedding(): void {
    while (embeddingInUse < capacity) {
      const next = nextEmbeddingWaiter();
      if (!next) return;
      removeAbortListener(next.waiter);
      embeddingInUse++;
      foregroundBurst = next.priority === "foreground" ? foregroundBurst + 1 : 0;
      next.waiter.resolve(makeEmbeddingRelease());
    }
  }

  function makeEmbeddingRelease(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      embeddingInUse--;
      drainEmbedding();
    };
  }

  function acquireEmbedding(
    priority: ResourcePriority,
    signal?: AbortSignal,
  ): Promise<() => void> {
    signal = signalFor(signal);
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const queue = embeddingWaiters[priority];
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      embeddingWaiters[priority].push(waiter);
      drainEmbedding();
    });
  }

  function drainBackgroundGate(): void {
    if (foregroundActive > 0) return;
    for (const waiter of backgroundWaiters.splice(0)) {
      removeAbortListener(waiter);
      waiter.resolve();
    }
  }

  function enterForeground(): () => void {
    foregroundActive++;
    let left = false;
    return (): void => {
      if (left) return;
      left = true;
      foregroundActive--;
      drainBackgroundGate();
    };
  }

  function waitForBackground(signal?: AbortSignal): Promise<void> {
    signal = signalFor(signal);
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (foregroundActive === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: BackgroundWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = backgroundWaiters.indexOf(waiter);
          if (index >= 0) backgroundWaiters.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      backgroundWaiters.push(waiter);
    });
  }

  function shutdown(reason = "pipeline shutdown"): void {
    if (shutdownController.signal.aborted) return;
    shutdownController.abort(new DOMException(reason, "AbortError"));
  }

  return {
    shutdownSignal: shutdownController.signal,
    signalFor,
    enterForeground,
    waitForBackground,
    acquireEmbedding,
    shutdown,
  };
}

/**
 * Keep the Embedder contract intact while moving provider round-trips behind
 * the shared priority arbiter. Background batches are deliberately chunked
 * so one enrichment pass cannot monopolize the provider for an entire queue.
 */
export function prioritizeEmbedder(
  inner: Embedder | null,
  resources: ForegroundResources,
  priority: ResourcePriority,
  backgroundChunkSize = 8,
): Embedder | null {
  if (!inner) return null;

  async function embedOne(
    input: string | EmbedInput,
    options?: EmbedCallOptions,
  ): Promise<EmbeddingVector> {
    const signal = resources.signalFor(options?.signal);
    const callOptions = { ...options, signal };
    if (priority === "background") await resources.waitForBackground(signal);
    const release = await resources.acquireEmbedding(priority, signal);
    try {
      return await inner!.embedOne(input, callOptions);
    } finally {
      release();
    }
  }

  async function embedMany(
    inputs: Array<string | EmbedInput>,
    options?: EmbedCallOptions,
  ): Promise<EmbeddingVector[]> {
    const signal = resources.signalFor(options?.signal);
    const callOptions = { ...options, signal };
    if (priority === "foreground" || inputs.length <= backgroundChunkSize) {
      if (priority === "background") await resources.waitForBackground(signal);
      const release = await resources.acquireEmbedding(priority, signal);
      try {
        return await inner!.embedMany(inputs, callOptions);
      } finally {
        release();
      }
    }

    const results: EmbeddingVector[] = [];
    for (let start = 0; start < inputs.length; start += backgroundChunkSize) {
      await resources.waitForBackground(signal);
      const release = await resources.acquireEmbedding(priority, signal);
      try {
        results.push(
          ...await inner!.embedMany(inputs.slice(start, start + backgroundChunkSize), callOptions),
        );
      } finally {
        release();
      }
    }
    return results;
  }

  async function embedManySettled(
    inputs: Array<string | EmbedInput>,
    options?: EmbedCallOptions,
  ): Promise<EmbeddingSettledResult[]> {
    const signal = resources.signalFor(options?.signal);
    const callOptions = { ...options, signal };
    const run = async (slice: Array<string | EmbedInput>): Promise<EmbeddingSettledResult[]> => {
      if (inner!.embedManySettled) return await inner!.embedManySettled(slice, callOptions);
      try {
        return (await inner!.embedMany(slice, callOptions)).map((vector) => ({
          ok: true as const,
          vector,
        }));
      } catch (err) {
        const error = err instanceof MemosError
          ? err
          : new MemosError(
              ERROR_CODES.EMBEDDING_UNAVAILABLE,
              `legacy embedMany failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        return slice.map(() => ({ ok: false as const, error }));
      }
    };
    if (priority === "foreground" || inputs.length <= backgroundChunkSize) {
      if (priority === "background") await resources.waitForBackground(signal);
      const release = await resources.acquireEmbedding(priority, signal);
      try {
        return await run(inputs);
      } finally {
        release();
      }
    }

    const results: EmbeddingSettledResult[] = [];
    for (let start = 0; start < inputs.length; start += backgroundChunkSize) {
      await resources.waitForBackground(signal);
      const release = await resources.acquireEmbedding(priority, signal);
      try {
        results.push(...await run(inputs.slice(start, start + backgroundChunkSize)));
      } finally {
        release();
      }
    }
    return results;
  }

  return {
    get dimensions() {
      return inner.dimensions;
    },
    get provider() {
      return inner.provider;
    },
    get model() {
      return inner.model;
    },
    embedOne,
    embedMany,
    embedManySettled,
    stats: () => inner.stats(),
    resetCache: () => inner.resetCache(),
    close: () => inner.close(),
  };
}
