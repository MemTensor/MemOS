/**
 * Public entry point for `core/llm/`.
 */

export {
  createLlmClient,
  createLlmClientWithProvider,
  makeProviderFor,
} from "./client.js";
export {
  parseLlmJson,
  buildJsonSystemHint,
} from "./json-mode.js";
export {
  registerHostLlmBridge,
  getHostLlmBridge,
  __resetHostLlmBridgeForTests,
  type HostLlmBridge,
  type HostLlmCompleteInput,
  type HostLlmCompletion,
} from "./host-bridge.js";
export { OpenAiLlmProvider } from "./providers/openai.js";
export { AnthropicLlmProvider } from "./providers/anthropic.js";
export { GeminiLlmProvider } from "./providers/gemini.js";
export { BedrockLlmProvider } from "./providers/bedrock.js";
export { HostLlmProvider } from "./providers/host.js";
export { LocalOnlyLlmProvider } from "./providers/local-only.js";
export * from "./prompts/index.js";
export type {
  LlmCallOptions,
  LlmCompleteJsonOptions,
  LlmCompletion,
  LlmClient,
  LlmClientStats,
  LlmConfig,
  LlmJsonCompletion,
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderLogger,
  LlmProviderName,
  LlmRole,
  LlmStreamChunk,
  LlmUsage,
  ProviderCallInput,
  ProviderCompletion,
} from "./types.js";
