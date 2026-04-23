/**
 * Voyage AI embeddings.
 *
 * Endpoint: https://api.voyageai.com/v1/embeddings
 * Default model: voyage-3 (1024-dim)
 * Query / document toggle via `input_type`.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { httpPostJson } from "../fetcher.js";
import type {
  EmbedRole,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
} from "../types.js";

interface VoyageResp {
  data?: Array<{ embedding?: number[] }>;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "voyage";

  async embed(texts: string[], role: EmbedRole, ctx: ProviderCallCtx): Promise<number[][]> {
    const { config, log, signal } = ctx;
    if (!config.apiKey) {
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        "voyage provider requires config.embedding.apiKey",
        { provider: this.name },
      );
    }
    const url = config.endpoint && config.endpoint.length > 0
      ? config.endpoint
      : "https://api.voyageai.com/v1/embeddings";
    const model = config.model && config.model.length > 0 ? config.model : "voyage-3";

    const resp = await httpPostJson<VoyageResp>({
      url,
      body: {
        input: texts,
        model,
        input_type: role === "query" ? "query" : "document",
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

    const rows = resp.data;
    if (!Array.isArray(rows)) {
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        "voyage returned no data[]",
        { provider: this.name, url },
      );
    }
    return rows.map((r, i) => {
      if (!Array.isArray(r.embedding)) {
        throw new MemosError(
          ERROR_CODES.EMBEDDING_UNAVAILABLE,
          `voyage row ${i} missing embedding`,
          { provider: this.name, url },
        );
      }
      return r.embedding;
    });
  }
}
