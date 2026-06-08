import type {
  LlmCallOptions,
  LlmClient,
  LlmClientStats,
  LlmCompleteJsonOptions,
  LlmCompletion,
  LlmJsonCompletion,
  LlmMessage,
  LlmProviderName,
  LlmStreamChunk,
} from "../llm/types.js";
import type { Semaphore } from "./semaphore.js";

/**
 * Wrap an LLM client so expensive background subscribers share one
 * process-wide concurrency budget without changing call-site semantics.
 */
export function rateLimitLlmClient(client: LlmClient | null, semaphore: Semaphore): LlmClient | null {
  if (!client) return null;
  return new RateLimitedLlmClient(client, semaphore);
}

class RateLimitedLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly semaphore: Semaphore,
  ) {}

  get provider(): LlmProviderName {
    return this.inner.provider;
  }

  get model(): string {
    return this.inner.model;
  }

  get canStream(): boolean {
    return this.inner.canStream;
  }

  async complete(
    messages: LlmMessage[] | string,
    opts?: LlmCallOptions,
  ): Promise<LlmCompletion> {
    const release = await this.semaphore.acquire();
    try {
      return await this.inner.complete(messages, opts);
    } finally {
      release();
    }
  }

  async completeJson<T>(
    messages: LlmMessage[] | string,
    opts?: LlmCompleteJsonOptions<T>,
  ): Promise<LlmJsonCompletion<T>> {
    const release = await this.semaphore.acquire();
    try {
      return await this.inner.completeJson(messages, opts);
    } finally {
      release();
    }
  }

  async *stream(
    messages: LlmMessage[] | string,
    opts?: LlmCallOptions,
  ): AsyncIterable<LlmStreamChunk> {
    const release = await this.semaphore.acquire();
    try {
      yield* this.inner.stream(messages, opts);
    } finally {
      release();
    }
  }

  stats(): LlmClientStats {
    return this.inner.stats();
  }

  resetStats(): void {
    this.inner.resetStats();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
