/**
 * Public entry point for `core/embedding/`.
 */

export {
  createEmbedder,
  createEmbedderWithProvider,
  makeProviderFor,
} from "./embedder.js";
export {
  LruEmbedCache,
  NullEmbedCache,
  makeCacheKey,
  type EmbedCache,
  type EmbedCacheKey,
  type EmbedCacheStats,
} from "./cache.js";
export { l2Normalize, enforceDim, postProcess, toFloat32 } from "./normalize.js";
export { createEmbeddingRetryWorker, systemErrorEvent } from "./retry-worker.js";
export type { EmbeddingRetryWorker } from "./retry-worker.js";
export type {
  EmbedInput,
  EmbedRole,
  EmbedStats,
  Embedder,
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
  ProviderLogger,
} from "./types.js";
export { LocalEmbeddingProvider, __resetLocalExtractorForTests } from "./providers/local.js";
export { OpenAiEmbeddingProvider } from "./providers/openai.js";
export { GeminiEmbeddingProvider } from "./providers/gemini.js";
export { CohereEmbeddingProvider } from "./providers/cohere.js";
export { VoyageEmbeddingProvider } from "./providers/voyage.js";
export { MistralEmbeddingProvider } from "./providers/mistral.js";
