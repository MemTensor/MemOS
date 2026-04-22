/**
 * Host-delegated LLM provider. Requires an adapter to have called
 * `registerHostLlmBridge(bridge)` before the client makes a call.
 *
 * The host typically exposes one thing: prompt → text. That means:
 *   - No native streaming. We emit the whole text as a single `done: true` chunk.
 *   - No native JSON mode. `json-mode.ts` is responsible for injecting schema hints.
 *   - No stop sequences. Providers are expected to ignore `opts.stop` here.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { getHostLlmBridge } from "../host-bridge.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderName,
  LlmStreamChunk,
  ProviderCallInput,
  ProviderCompletion,
} from "../types.js";

export class HostLlmProvider implements LlmProvider {
  readonly name: LlmProviderName = "host";

  async complete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion> {
    const bridge = getHostLlmBridge();
    if (!bridge) {
      throw new MemosError(
        ERROR_CODES.LLM_UNAVAILABLE,
        "host provider requires a registered HostLlmBridge (no adapter attached?)",
        { provider: this.name },
      );
    }
    const t0 = Date.now();
    const res = await bridge.complete({
      messages,
      model: ctx.config.model || undefined,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      timeoutMs: ctx.config.timeoutMs,
      signal: ctx.signal,
    });
    return {
      text: res.text,
      usage: res.usage,
      durationMs: res.durationMs ?? Date.now() - t0,
    };
  }

  // No native stream — facade wraps `complete` in a 1-chunk async iterable.
  // eslint-disable-next-line require-yield
  async *stream(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): AsyncGenerator<LlmStreamChunk> {
    const res = await this.complete(messages, opts, ctx);
    yield { delta: res.text, done: false };
    yield { delta: "", done: true, usage: res.usage };
  }
}
