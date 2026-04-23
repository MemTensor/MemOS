/**
 * Local MiniLM embeddings via `@huggingface/transformers`.
 *
 * Model: by default `Xenova/all-MiniLM-L6-v2` — 384-dim, ~23 MB on first run,
 * quantized to int8 for CPU friendliness. The model loads lazily on the first
 * call and is shared across all embedders in the process.
 *
 * Output: `pipeline("feature-extraction")` already supports mean-pooling and
 * L2-normalize via `{ pooling: "mean", normalize: true }`. We intentionally
 * don't normalize again on top of that.
 */

import type {
  EmbedRole,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
} from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = (text: string, options?: Record<string, unknown>) => Promise<any>;

let extractorPromise: Promise<Extractor> | null = null;
let currentModel: string | null = null;

async function ensureExtractor(model: string, log: ProviderCallCtx["log"]): Promise<Extractor> {
  if (extractorPromise && currentModel === model) return extractorPromise;
  if (extractorPromise && currentModel && currentModel !== model) {
    log.warn("model.swap", { from: currentModel, to: model });
    extractorPromise = null;
  }
  log.info("loading", { model });
  const t0 = Date.now();
  extractorPromise = (async () => {
    // Dynamic import keeps the heavy dep out of the hot path for tests that
    // don't need it.
    const mod = await import("@huggingface/transformers");
    const pipeline = (mod as unknown as { pipeline: PipelineFn }).pipeline;
    const ext = (await pipeline("feature-extraction", model, {
      dtype: "q8",
      device: "cpu",
    })) as unknown as Extractor;
    log.info("ready", { model, durationMs: Date.now() - t0 });
    return ext;
  })().catch((err) => {
    extractorPromise = null;
    log.error("load_failed", {
      model,
      err: { name: (err as Error).name, message: (err as Error).message },
    });
    throw err;
  });
  currentModel = model;
  return extractorPromise;
}

/**
 * Reference type for the dynamic `pipeline` import. We can't import the
 * real type at compile time without a static `import type`, which would pull
 * the library into test builds. This shape matches what we actually use.
 */
type PipelineFn = (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "local";

  async embed(texts: string[], _role: EmbedRole, ctx: ProviderCallCtx): Promise<number[][]> {
    const { config, log } = ctx;
    const ext = await ensureExtractor(config.model, log);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await ext(texts[i]!, { pooling: "mean", normalize: true });
      const arr = (result as { data?: Float32Array }).data;
      if (!arr) {
        throw new Error("[embedding.local] extractor returned no .data");
      }
      out.push(Array.from(arr));
    }
    return out;
  }

  async close(): Promise<void> {
    // The transformers pipeline doesn't expose a .close(); GC handles it.
    extractorPromise = null;
    currentModel = null;
  }
}

// Test hook — tests can reset the cached extractor without touching internals.
export function __resetLocalExtractorForTests(): void {
  extractorPromise = null;
  currentModel = null;
}
