/**
 * Cohere embed v1.
 *
 * Distinguishes document vs query via `input_type: "search_document" | "search_query"`.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { httpPostJson } from "../fetcher.js";
import type {
  EmbedRole,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
} from "../types.js";

interface CohereResp {
  embeddings?: number[][];
}

export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "cohere";

  async embed(texts: string[], role: EmbedRole, ctx: ProviderCallCtx): Promise<number[][]> {
    const { config, log, signal } = ctx;
    if (!config.apiKey) {
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        "cohere provider requires config.embedding.apiKey",
        { provider: this.name },
      );
    }
    const url = config.endpoint && config.endpoint.length > 0
      ? config.endpoint
      : "https://api.cohere.ai/v1/embed";
    const model = config.model && config.model.length > 0 ? config.model : "embed-english-v3.0";

    const resp = await httpPostJson<CohereResp>({
      url,
      body: {
        texts,
        model,
        input_type: role === "query" ? "search_query" : "search_document",
        truncate: "END",
      },
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...config.headers,
      },
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      signal,
      provider: this.name,
      log,
    });

    if (!Array.isArray(resp.embeddings)) {
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        "cohere returned no embeddings[]",
        { provider: this.name, url },
      );
    }
    return resp.embeddings;
  }
}
