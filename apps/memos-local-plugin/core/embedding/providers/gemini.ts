/**
 * Google Gemini embeddings via REST (`batchEmbedContents`).
 *
 * Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/<model>:batchEmbedContents?key=<KEY>`
 * Defaults: `text-embedding-004` (768-dim).
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { httpPostJson } from "../fetcher.js";
import type {
  EmbedRole,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
} from "../types.js";

interface GeminiResp {
  embeddings?: Array<{ values?: number[] }>;
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "gemini";

  async embed(texts: string[], role: EmbedRole, ctx: ProviderCallCtx): Promise<number[][]> {
    const { config, log, signal } = ctx;
    if (!config.apiKey) {
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        "gemini provider requires config.embedding.apiKey",
        { provider: this.name },
      );
    }
    const model = config.model && config.model.length > 0 ? config.model : "text-embedding-004";
    const base = config.endpoint && config.endpoint.length > 0
      ? config.endpoint.replace(/\/+$/, "")
      : "https://generativelanguage.googleapis.com/v1beta";
    const url = `${base}/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(config.apiKey)}`;
    const taskType = role === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";

    const resp = await httpPostJson<GeminiResp>({
      url,
      body: {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType,
        })),
      },
      headers: { ...config.headers },
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      signal,
      provider: this.name,
      log,
    });

    const rows = resp.embeddings;
    if (!Array.isArray(rows)) {
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        "gemini returned no embeddings[] field",
        { provider: this.name, url },
      );
    }
    return rows.map((r, i) => {
      const v = r.values;
      if (!Array.isArray(v)) {
        throw new MemosError(
          ERROR_CODES.EMBEDDING_UNAVAILABLE,
          `gemini row ${i} missing values`,
          { provider: this.name, url },
        );
      }
      return v;
    });
  }
}
