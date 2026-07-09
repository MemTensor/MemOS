/**
 * OpenAI-compatible embeddings endpoint.
 *
 * Works with vanilla OpenAI and any drop-in API:
 *   - Azure OpenAI (set `endpoint`)
 *   - Zhipu, SiliconFlow, Bailian, Groq, etc.
 *
 * Request shape:  POST <endpoint>  { input: string[], model }
 * Response shape: { data: [{ embedding: number[] }, ...] }
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { httpPostJson } from "../fetcher.js";
import type {
  EmbedRole,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
} from "../types.js";

interface OpenAiResp {
  data?: Array<{ embedding?: number[] }>;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "openai_compatible";

  async embed(texts: string[], _role: EmbedRole, ctx: ProviderCallCtx): Promise<number[][]> {
    const { config, log, signal } = ctx;
    if (!config.apiKey) {
      throw new MemosError(
        ERROR_CODES.EMBEDDING_UNAVAILABLE,
        "openai_compatible provider requires config.embedding.apiKey",
        { provider: this.name },
      );
    }
    const url = normalizeEndpoint(
      config.endpoint && config.endpoint.length > 0
        ? config.endpoint
        : "https://api.openai.com/v1/embeddings",
    );
    const model = config.model && config.model.length > 0 ? config.model : "text-embedding-3-small";
    const resp = await httpPostJson<OpenAiResp>({
      url,
      body: { input: texts, model },
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
        "openai_compatible returned no data[] field",
        { provider: this.name, url },
      );
    }
    const out: number[][] = [];
    for (let i = 0; i < rows.length; i++) {
      const emb = rows[i]?.embedding;
      if (!Array.isArray(emb)) {
        throw new MemosError(
          ERROR_CODES.EMBEDDING_UNAVAILABLE,
          `openai_compatible row ${i} missing embedding`,
          { provider: this.name, url },
        );
      }
      out.push(emb);
    }
    return out;
  }
}

function normalizeEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/embeddings")) return stripped;
  return `${stripped}/embeddings`;
}
