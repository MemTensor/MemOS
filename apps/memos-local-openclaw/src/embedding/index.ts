import type { EmbeddingConfig, Logger, OpenClawAPI } from "../types";
import { embedOpenAI } from "./providers/openai";
import { embedGemini } from "./providers/gemini";
import { embedCohere, embedCohereQuery } from "./providers/cohere";
import { embedVoyage } from "./providers/voyage";
import { embedMistral } from "./providers/mistral";
import { embedLocal } from "./local";
import { modelHealth } from "../ingest/providers";

type EmbeddingInputKind = "document" | "query";

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

  get model(): string {
    if (this.provider === "local") return "";
    return this.cfg?.model ?? "";
  }

  get dimensions(): number {
    if (this.provider === "local") return 384;
    return this.cfg?.dimensions ?? 1536;
  }

  /**
   * Canonical identity of the embedding space this embedder produces vectors in.
   * Format: "provider:model:dimensions". Used to detect when stored vectors
   * were produced by a different model than the live config.
   */
  get signature(): string {
    return `${this.provider}:${this.model}:${this.dimensions}`;
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
    const vecs = await this.embedBatch([text], "query");
    return vecs[0];
  }

  private async embedBatch(
    texts: string[],
    inputKind: EmbeddingInputKind = "document",
  ): Promise<number[][]> {
    const provider = this.provider;
    const cfg = this.cfg;
    const inputType = this.resolveInputType(inputKind);

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
          result = await embedOpenAI(texts, cfg!, this.log, inputType); break;
        case "openclaw":
          result = await this.embedOpenClaw(texts, inputType); break;
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

  private resolveInputType(inputKind: EmbeddingInputKind): string | undefined {
    if (!this.cfg) return undefined;
    if (inputKind === "query") return this.cfg.queryInputType ?? this.cfg.inputType;
    return this.cfg.documentInputType ?? this.cfg.inputType;
  }

  private async embedOpenClaw(texts: string[], inputType?: string): Promise<number[][]> {
    if (!this.openclawAPI) {
      throw new Error(
        "OpenClaw API not available. Ensure sharing.capabilities.hostEmbedding is enabled in config."
      );
    }

    this.log.debug(`Calling OpenClaw embed API for ${texts.length} texts`);
    const response = await this.openclawAPI.embed({
      texts,
      model: this.cfg?.model,
      inputType,
    });

    return response.embeddings;
  }
}
