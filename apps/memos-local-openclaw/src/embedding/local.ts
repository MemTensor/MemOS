import type { Logger } from "../types";
import { DEFAULTS } from "../types";

let extractorPromise: Promise<any> | null = null;
let callCount = 0;

// Read from env or use default
const RESET_AFTER_CALLS = parseInt(process.env.MEMOS_EMBED_RESET_AFTER_CALLS || "50", 10);

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

async function resetExtractor(log: Logger): Promise<void> {
  if (!extractorPromise) return;

  try {
    const ext = await extractorPromise;
    // Attempt to dispose the pipeline to free ONNX session resources
    if (typeof ext?.dispose === "function") {
      await ext.dispose();
    }
  } catch (err) {
    log.warn(`Failed to dispose extractor: ${err}`);
  }

  extractorPromise = null;
  callCount = 0;
  log.debug("Local embedding pipeline reset to free native memory");
}

export async function embedLocal(texts: string[], log: Logger): Promise<number[][]> {
  const ext = await getExtractor(log);
  const results: number[][] = [];

  for (const text of texts) {
    const output = await ext(text, { pooling: "mean", normalize: true });

    // Extract the embedding vector
    results.push(Array.from(output.data as Float32Array).slice(0, DEFAULTS.localEmbeddingDimensions));

    // Explicitly release the output tensor to prevent ONNX memory leak
    try {
      // Null out the data reference
      (output as any).data = null;
    } catch {}

    try {
      // Call dispose if available
      if (typeof (output as any).dispose === "function") {
        (output as any).dispose();
      }
    } catch {}

    callCount++;
  }

  // Periodically reset the pipeline to prevent long-term memory accumulation
  // Set MEMOS_EMBED_RESET_AFTER_CALLS=0 to disable periodic reset
  if (RESET_AFTER_CALLS > 0 && callCount >= RESET_AFTER_CALLS) {
    log.debug(`Reached ${callCount} embedding calls, resetting pipeline to free native memory`);
    await resetExtractor(log);
  }

  return results;
}
