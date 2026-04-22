/**
 * Mistral AI embeddings.
 *
 * Endpoint: https://api.mistral.ai/v1/embeddings
 * Default model: mistral-embed (1024-dim).
 * Shape is OpenAI-compatible: `{ data: [{ embedding }] }`.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { httpPostJson } from "../fetcher.js";
import type {
  EmbedRole,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
} from "../types.js";

interface MistralResp {
  data?: Array<{ embedding?: number[] }>;
}

export class MistralEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "mistral";

  async embed(texts: string[], _role: EmbedRole, ctx: ProviderCallCtx): Promise<number[][]> {
    const { config, log, signal } = ctx;
    if (!config.apiKey) {
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        "mistral provider requires config.embedding.apiKey",
        { provider: this.name },
      );
    }
    const url = config.endpoint && config.endpoint.length > 0
      ? config.endpoint
      : "https://api.mistral.ai/v1/embeddings";
    const model = config.model && config.model.length > 0 ? config.model : "mistral-embed";

    const resp = await httpPostJson<MistralResp>({
      url,
      body: { input: texts, model, encoding_format: "float" },
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
        "mistral returned no data[]",
        { provider: this.name, url },
      );
    }
    return rows.map((r, i) => {
      if (!Array.isArray(r.embedding)) {
        throw new MemosError(
          ERROR_CODES.EMBEDDING_UNAVAILABLE,
          `mistral row ${i} missing embedding`,
          { provider: this.name, url },
        );
      }
      return r.embedding;
    });
  }
}
