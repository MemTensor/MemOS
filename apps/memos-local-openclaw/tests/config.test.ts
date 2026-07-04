import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import { DEFAULTS } from "../src/types";

describe("resolveConfig recall.autoRecallMinQueryLength", () => {
  it("defaults to DEFAULTS.autoRecallMinQueryLength when not set", () => {
    const resolved = resolveConfig({}, "/tmp/memos-config-min-query-default");
    expect(resolved.recall?.autoRecallMinQueryLength).toBe(DEFAULTS.autoRecallMinQueryLength);
    expect(resolved.recall?.autoRecallMinQueryLength).toBe(4);
  });

  it("preserves an explicit override", () => {
    const resolved = resolveConfig(
      { recall: { autoRecallMinQueryLength: 10 } },
      "/tmp/memos-config-min-query-override",
    );
    expect(resolved.recall?.autoRecallMinQueryLength).toBe(10);
  });

  it("preserves 0 explicitly (disables the short-query skip)", () => {
    const resolved = resolveConfig(
      { recall: { autoRecallMinQueryLength: 0 } },
      "/tmp/memos-config-min-query-zero",
    );
    expect(resolved.recall?.autoRecallMinQueryLength).toBe(0);
  });
});

describe("resolveConfig", () => {
  it("injects openclaw providers into existing blocks when host capabilities are enabled", () => {
    const resolved = resolveConfig(
      {
        embedding: {
          model: "embed-model",
          endpoint: "http://embedding.local",
          batchSize: 16,
        } as any,
        summarizer: {
          model: "summary-model",
          endpoint: "http://summary.local",
          temperature: 0.3,
        } as any,
        sharing: {
          capabilities: {
            hostEmbedding: true,
            hostCompletion: true,
          },
        },
      },
      "/tmp/memos-config-test",
    );

    expect(resolved.embedding).toMatchObject({
      provider: "openclaw",
      model: "embed-model",
      endpoint: "http://embedding.local",
      batchSize: 16,
      capabilities: {
        hostEmbedding: true,
        hostCompletion: true,
      },
    });

    expect(resolved.summarizer).toMatchObject({
      provider: "openclaw",
      model: "summary-model",
      endpoint: "http://summary.local",
      temperature: 0.3,
      capabilities: {
        hostEmbedding: true,
        hostCompletion: true,
      },
    });
  });

  describe("recall.autoRecallMaxResults", () => {
    it("leaves autoRecallMaxResults undefined when no recall config is provided (fall-through to maxResultsDefault)", () => {
      const resolved = resolveConfig(undefined, "/tmp/memos-config-recall-default");

      // Default policy: auto-recall path inherits maxResultsDefault when not overridden.
      expect(resolved.recall?.maxResultsDefault).toBe(6);
      expect(resolved.recall?.autoRecallMaxResults).toBeUndefined();
    });

    it("preserves an explicit autoRecallMaxResults value when set", () => {
      const resolved = resolveConfig(
        {
          recall: {
            maxResultsDefault: 6,
            autoRecallMaxResults: 3,
          },
        } as any,
        "/tmp/memos-config-recall-override",
      );

      expect(resolved.recall?.maxResultsDefault).toBe(6);
      expect(resolved.recall?.autoRecallMaxResults).toBe(3);
    });

    it("allows independent control: maxResultsDefault for memory_search, autoRecallMaxResults for auto-recall", () => {
      const resolved = resolveConfig(
        {
          recall: {
            maxResultsDefault: 10,
            autoRecallMaxResults: 5,
          },
        } as any,
        "/tmp/memos-config-recall-split",
      );

      expect(resolved.recall?.maxResultsDefault).toBe(10);
      expect(resolved.recall?.autoRecallMaxResults).toBe(5);
    });
  });

  it("preserves explicit user providers when host capabilities are enabled", () => {
    const resolved = resolveConfig(
      {
        embedding: {
          provider: "local",
          model: "embed-model",
        },
        summarizer: {
          provider: "openai_compatible",
          model: "summary-model",
        },
        sharing: {
          capabilities: {
            hostEmbedding: true,
            hostCompletion: true,
          },
        },
      },
      "/tmp/memos-config-test",
    );

    expect(resolved.embedding).toMatchObject({
      provider: "local",
      model: "embed-model",
      capabilities: {
        hostEmbedding: true,
        hostCompletion: true,
      },
    });

    expect(resolved.summarizer).toMatchObject({
      provider: "openai_compatible",
      model: "summary-model",
      capabilities: {
        hostEmbedding: true,
        hostCompletion: true,
      },
    });
  });
});
