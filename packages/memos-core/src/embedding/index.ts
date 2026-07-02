import type { EmbeddingConfig, Logger, OpenClawAPI } from "../types";
import { embedOpenAI } from "./providers/openai";
import { embedGemini } from "./providers/gemini";
import { embedCohere, embedCohereQuery } from "./providers/cohere";
import { embedVoyage } from "./providers/voyage";
import { embedMistral } from "./providers/mistral";
import { embedLocal } from "./local";
import { modelHealth } from "../ingest/providers";

export class Embedder {
  constructor(
    private cfg: EmbeddingConfig | undefined,
    private log: Logger,
    private openclawAPI?: OpenClawAPI,
  ) {}

  get provider(): string {
    if (this.cfg?.provider === "openclaw" && this.cfg.capabilities?.hostEmbedding !== true) {
      return "local";
    }
    return this.cfg?.provider ?? "local";
  }

  get dimensions(): number {
    if (this.provider === "local") return 384;
    return this.cfg?.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batchSize = this.cfg?.batchSize ?? 32;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const vecs = await this.embedBatch(batch);
      results.push(...vecs);
    }

    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    if (this.provider === "cohere" && this.cfg) {
      return embedCohereQuery(text, this.cfg, this.log);
    }
    const vecs = await this.embedBatch([text]);
    return vecs[0];
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const provider = this.provider;
    const cfg = this.cfg;

    const modelInfo = `${provider}/${cfg?.model ?? "default"}`;
    try {
      let result: number[][];
      switch (provider) {
        case "openai":
        case "openai_compatible":
        case "azure_openai":
        case "zhipu":
        case "siliconflow":
        case "bailian":
          result = await embedOpenAI(texts, cfg!, this.log); break;
        case "gemini":
          result = await embedGemini(texts, cfg!, this.log); break;
        case "cohere":
          result = await embedCohere(texts, cfg!, this.log); break;
        case "mistral":
          result = await embedMistral(texts, cfg!, this.log); break;
        case "voyage":
          result = await embedVoyage(texts, cfg!, this.log); break;
        case "local":
        default:
          result = await embedLocal(texts, this.log); break;
      }
      modelHealth.recordSuccess("embedding", modelInfo);
      return result;
    } catch (err) {
      modelHealth.recordError("embedding", modelInfo, String(err));
      if (provider !== "local") {
        this.log.warn(`Embedding provider '${provider}' failed, falling back to local: ${err}`);
        return await embedLocal(texts, this.log);
      }
      throw err;
    }
  }

  private async embedOpenClaw(texts: string[]): Promise<number[][]> {
    if (!this.openclawAPI) {
      throw new Error(
        "OpenClaw API not available. Ensure sharing.capabilities.hostEmbedding is enabled in config."
      );
    }

    this.log.debug(`Calling OpenClaw embed API for ${texts.length} texts`);
    const response = await this.openclawAPI.embed({
      texts,
      model: this.cfg?.model,
    });

    return response.embeddings;
  }
}
