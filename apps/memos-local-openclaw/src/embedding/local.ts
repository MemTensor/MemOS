import type { Logger } from "../types";
import { DEFAULTS } from "../types";

let extractorPromise: Promise<any> | null = null;

function getExtractor(log: Logger): Promise<any> {
  if (extractorPromise) return extractorPromise;

  extractorPromise = (async () => {
    log.info("Loading local embedding model (first call may download ~23MB)...");
    const { pipeline } = await import("@huggingface/transformers");
    const ext = await pipeline("feature-extraction", DEFAULTS.localEmbeddingModel, {
      dtype: "q8",
      device: "cpu",
    });
    log.info("Local embedding model ready");
    return ext;
  })().catch((err) => {
    extractorPromise = null;
    throw err;
  });

  return extractorPromise;
}

export async function embedLocal(texts: string[], log: Logger): Promise<number[][]> {
  const ext = await getExtractor(log);
  const results: number[][] = [];

  for (const text of texts) {
    const output = await ext(text, { pooling: "mean", normalize: true });
    results.push(Array.from(output.data as Float32Array).slice(0, DEFAULTS.localEmbeddingDimensions));
  }

  return results;
}
