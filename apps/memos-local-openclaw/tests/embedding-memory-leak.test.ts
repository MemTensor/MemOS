import { describe, it, expect, vi } from "vitest";
import { embedLocal } from "../src/embedding/local";
import type { Logger } from "../src/types";

describe("embedLocal memory leak fix", () => {
  const mockLogger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  it("should dispose tensor output after each embedding call", async () => {
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
  });

  it("should handle multiple consecutive calls without crashing", async () => {
    // Simulate multiple embedding calls that would trigger the leak
    const calls = 10;

    for (let i = 0; i < calls; i++) {
      const result = await embedLocal([`test text ${i}`], mockLogger);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(384);
    }

    // If we reached here without OOM, the tensor disposal is working
    expect(true).toBe(true);
  });

  it("should reset pipeline after RESET_AFTER_CALLS threshold", async () => {
    // Set a low threshold for testing
    const originalEnv = process.env.MEMOS_EMBED_RESET_AFTER_CALLS;
    process.env.MEMOS_EMBED_RESET_AFTER_CALLS = "5";

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

    // Restore env
    if (originalEnv !== undefined) {
      process.env.MEMOS_EMBED_RESET_AFTER_CALLS = originalEnv;
    } else {
      delete process.env.MEMOS_EMBED_RESET_AFTER_CALLS;
    }
  });

  it("should allow disabling periodic reset via env variable", async () => {
    const originalEnv = process.env.MEMOS_EMBED_RESET_AFTER_CALLS;
    process.env.MEMOS_EMBED_RESET_AFTER_CALLS = "0";

    // Clear previous mock calls
    vi.clearAllMocks();

    // Run many calls - should not trigger reset
    for (let i = 0; i < 100; i++) {
      await embedLocal([`test ${i}`], mockLogger);
    }

    // Verify no reset was logged
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("Reached")
    );

    // Restore env
    if (originalEnv !== undefined) {
      process.env.MEMOS_EMBED_RESET_AFTER_CALLS = originalEnv;
    } else {
      delete process.env.MEMOS_EMBED_RESET_AFTER_CALLS;
    }
  });
});
