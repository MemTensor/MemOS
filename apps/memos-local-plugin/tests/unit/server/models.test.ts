import { describe, expect, it, vi } from "vitest";

import { probeLocalEmbedding } from "../../../server/routes/models.js";

describe("local embedding model probe", () => {
  it("loads the default MiniLM model and verifies a real vector", async () => {
    const embedOne = vi.fn(async () => Float32Array.from([0.1, 0.2, 0.3]));
    const create = vi.fn(() => ({ embedOne }));

    await expect(probeLocalEmbedding("", create)).resolves.toBe(3);
    expect(create).toHaveBeenCalledWith("Xenova/all-MiniLM-L6-v2");
    expect(embedOne).toHaveBeenCalledWith("ping");
  });

  it("surfaces download/load guidance on failure", async () => {
    const embedOne = vi.fn(async () => {
      throw new Error("fetch failed");
    });

    await expect(
      probeLocalEmbedding("custom/minilm", () => ({ embedOne })),
    ).rejects.toThrow(
      "Local embedding model download/load failed; check access to Hugging Face: fetch failed",
    );
  });
});
