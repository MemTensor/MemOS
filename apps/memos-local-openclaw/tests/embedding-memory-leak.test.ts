import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/types";

const mockTransformers = vi.hoisted(() => {
  const disposeOutput = vi.fn();
  const disposeExtractor = vi.fn();
  const extractor = vi.fn(async () => ({
    data: new Float32Array(384).fill(0.5),
    dispose: disposeOutput,
  }));
  Object.assign(extractor, { dispose: disposeExtractor });
  return {
    disposeOutput,
    disposeExtractor,
    extractor,
    pipeline: vi.fn(async () => extractor),
  };
});

vi.mock("@huggingface/transformers", () => ({
  pipeline: mockTransformers.pipeline,
}));

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function loadEmbedLocal() {
  vi.resetModules();
  return import("../src/embedding/local");
}

describe("embedLocal memory leak fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEMOS_EMBED_RESET_AFTER_CALLS;
  });

  afterEach(() => {
    delete process.env.MEMOS_EMBED_RESET_AFTER_CALLS;
    vi.restoreAllMocks();
  });

  it("should dispose tensor output after each embedding call", async () => {
    const { embedLocal } = await loadEmbedLocal();
    const mockLogger = createLogger();
    const texts = ["test embedding 1", "test embedding 2"];

    const result = await embedLocal(texts, mockLogger);

    // Verify we got valid embeddings
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(384); // all-MiniLM-L6-v2 dimension
    expect(result[1]).toHaveLength(384);

    // Verify embeddings are valid numbers
    result.forEach(embedding => {
      embedding.forEach(value => {
        expect(typeof value).toBe("number");
        expect(isFinite(value)).toBe(true);
      });
    });

    expect(mockTransformers.pipeline).toHaveBeenCalledTimes(1);
    expect(mockTransformers.extractor).toHaveBeenCalledTimes(2);
    expect(mockTransformers.disposeOutput).toHaveBeenCalledTimes(2);
  });

  it("should handle multiple consecutive calls without crashing", async () => {
    const { embedLocal } = await loadEmbedLocal();
    const mockLogger = createLogger();
    // Simulate multiple embedding calls that would trigger the leak
    const calls = 10;

    for (let i = 0; i < calls; i++) {
      const result = await embedLocal([`test text ${i}`], mockLogger);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(384);
    }

    // If we reached here without OOM, the tensor disposal is working
    expect(mockTransformers.pipeline).toHaveBeenCalledTimes(1);
    expect(mockTransformers.disposeOutput).toHaveBeenCalledTimes(calls);
  });

  it("should reset pipeline after RESET_AFTER_CALLS threshold", async () => {
    // Set a low threshold for testing
    process.env.MEMOS_EMBED_RESET_AFTER_CALLS = "5";
    const { embedLocal } = await loadEmbedLocal();
    const mockLogger = createLogger();

    // This will trigger a reset after 5 calls
    const calls = 6;

    for (let i = 0; i < calls; i++) {
      const result = await embedLocal([`test ${i}`], mockLogger);
      expect(result[0]).toHaveLength(384);
    }

    // Verify reset was logged
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Reached 5 embedding calls")
    );
    expect(mockTransformers.disposeExtractor).toHaveBeenCalledTimes(1);
  });

  it("should allow disabling periodic reset via env variable", async () => {
    process.env.MEMOS_EMBED_RESET_AFTER_CALLS = "0";
    const { embedLocal } = await loadEmbedLocal();
    const mockLogger = createLogger();

    // Run many calls - should not trigger reset
    for (let i = 0; i < 100; i++) {
      await embedLocal([`test ${i}`], mockLogger);
    }

    // Verify no reset was logged
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("Reached")
    );
    expect(mockTransformers.disposeExtractor).not.toHaveBeenCalled();
  });
});
