import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";

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
