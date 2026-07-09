import { beforeAll, describe, expect, it } from "vitest";

import { LocalEmbeddingProvider } from "../../../core/embedding/providers/local.js";
import { initTestLogger } from "../../../core/logger/index.js";

describe("embedding/local (interface-only)", () => {
  beforeAll(() => initTestLogger());

  it("exposes name='local'", () => {
    const p = new LocalEmbeddingProvider();
    expect(p.name).toBe("local");
  });

  it("close() is callable without a prior embed() (no pipeline loaded)", async () => {
    const p = new LocalEmbeddingProvider();
    await p.close();
  });

  // Actual MiniLM download + inference is opt-in; gated so unit test budget
  // stays small and offline.
  const runReal = process.env.MEMOS_TEST_LOCAL_EMBED === "1";
  it.skipIf(!runReal)("loads MiniLM lazily on first embed()", async () => {
    const p = new LocalEmbeddingProvider();
    const noop = () => {};
    const log = { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
    const out = await p.embed(["hello"], "document", {
      config: {
        provider: "local",
        model: "Xenova/all-MiniLM-L6-v2",
        dimensions: 384,
        endpoint: "",
        apiKey: "",
        cache: { enabled: false, maxItems: 0 },
      },
      log,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(384);
  }, 120_000);
});
