import type { EmbeddingConfig, Logger } from "../types";
import { embedOpenAI } from "./providers/openai";
import { embedGemini } from "./providers/gemini";
import { embedCohere, embedCohereQuery } from "./providers/cohere";
import { embedVoyage } from "./providers/voyage";
import { embedMistral } from "./providers/mistral";
import { embedLocal } from "./local";

export class Embedder {
  constructor(
    private cfg: EmbeddingConfig | undefined,
    private log: Logger,
  ) {}

  get provider(): string {
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

    try {
      switch (provider) {
        case "openai":
        case "openai_compatible":
          return await embedOpenAI(texts, cfg!, this.log);
        case "gemini":
          return await embedGemini(texts, cfg!, this.log);
        case "azure_openai":
          return await embedOpenAI(texts, cfg!, this.log);
        case "cohere":
          return await embedCohere(texts, cfg!, this.log);
        case "mistral":
          return await embedMistral(texts, cfg!, this.log);
        case "voyage":
          return await embedVoyage(texts, cfg!, this.log);
        case "local":
        default:
          return await embedLocal(texts, this.log);
      }
    } catch (err) {
      if (provider !== "local") {
        this.log.warn(`Embedding provider '${provider}' failed, falling back to local: ${err}`);
        return await embedLocal(texts, this.log);
      }
      throw err;
    }
  }
}
