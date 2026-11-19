import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCallCtx } from "../../../core/embedding/types.js";
import { homedir } from "node:os";
import { join } from "node:path";

const { pipeline, env } = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: {
    remoteHost: "https://huggingface.co/",
    localModelPath: "/original/models",
    cacheDir: "/original/cache",
    allowRemoteModels: true,
  },
}));
vi.mock("@huggingface/transformers", () => ({ pipeline, env }));
import {
  LocalEmbeddingProvider,
  __resetLocalExtractorForTests,
} from "../../../core/embedding/providers/local.js";

const extractor = async () => ({ data: new Float32Array([1, 0]) });
function ctx(local: Record<string, unknown> = {}): ProviderCallCtx {
  return {
    config: {
      provider: "local",
      model: "test/model",
      dimensions: 2,
      local,
      openRouter: false,
      cache: { enabled: false, maxItems: 0 },
    },
    log: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("local model source and load status", () => {
  beforeEach(() => {
    __resetLocalExtractorForTests();
    pipeline.mockReset().mockResolvedValue(extractor);
    Object.assign(env, {
      remoteHost: "https://huggingface.co/",
      localModelPath: "/original/models",
      cacheDir: "/original/cache",
      allowRemoteModels: true,
    });
    vi.stubEnv("HF_ENDPOINT", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("keeps the default model cache outside installed package files", async () => {
    pipeline.mockImplementation(async () => {
      expect(env.cacheDir).toBe(join(homedir(), ".cache", "memos", "models"));
      return extractor;
    });
    await new LocalEmbeddingProvider().embed(["test"], "query", ctx());
  });

  it("uses HF_ENDPOINT but lets explicit local configuration take precedence", async () => {
    vi.stubEnv("HF_ENDPOINT", "https://env-mirror.example/");
    const observed: string[] = [];
    pipeline.mockImplementation(async () => {
      observed.push(env.remoteHost);
      return extractor;
    });
    const provider = new LocalEmbeddingProvider();
    await provider.embed(["test"], "query", ctx());
    await provider.embed(
      ["test"],
      "query",
      ctx({ remoteHost: "https://config-mirror.example" }),
    );
    expect(observed).toEqual([
      "https://env-mirror.example/",
      "https://config-mirror.example/",
    ]);
    expect(env.remoteHost).toBe("https://huggingface.co/");
  });

  it("applies offline directories before loading and restores the shared environment", async () => {
    pipeline.mockImplementation(async (_task, _model, options) => {
      expect(env).toMatchObject({
        localModelPath: "/models",
        cacheDir: "/cache",
        allowRemoteModels: false,
      });
      expect(options).toMatchObject({ local_files_only: true });
      return extractor;
    });
    await new LocalEmbeddingProvider().embed(
      ["test"],
      "query",
      ctx({ modelPath: "/models", cacheDir: "/cache", offline: true }),
    );
    expect(env).toMatchObject({
      localModelPath: "/original/models",
      cacheDir: "/original/cache",
      allowRemoteModels: true,
    });
  });

  it("restores environment after a failure and permits a later retry", async () => {
    pipeline
      .mockRejectedValueOnce(new Error("synthetic failure"))
      .mockResolvedValue(extractor);
    const provider = new LocalEmbeddingProvider();
    await expect(
      provider.embed(
        ["test"],
        "query",
        ctx({ remoteHost: "https://mirror.example" }),
      ),
    ).rejects.toThrow("synthetic failure");
    expect(env.remoteHost).toBe("https://huggingface.co/");
    await expect(
      provider.embed(
        ["test"],
        "query",
        ctx({ remoteHost: "https://mirror.example" }),
      ),
    ).resolves.toEqual([[1, 0]]);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it("serializes loads with different sources so their global settings do not overlap", async () => {
    let finish!: (value: typeof extractor) => void;
    const first = new Promise<typeof extractor>((resolve) => {
      finish = resolve;
    });
    const sources: string[] = [];
    pipeline.mockImplementation(async () => {
      sources.push(env.remoteHost);
      return sources.length === 1 ? first : extractor;
    });
    const provider = new LocalEmbeddingProvider();
    const a = provider.embed(
      ["a"],
      "query",
      ctx({ remoteHost: "https://a.example/" }),
    );
    await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
    const b = provider.embed(
      ["b"],
      "query",
      ctx({ remoteHost: "https://b.example/" }),
    );
    await Promise.resolve();
    expect(pipeline).toHaveBeenCalledTimes(1);
    finish(extractor);
    await Promise.all([a, b]);
    expect(sources).toEqual(["https://a.example/", "https://b.example/"]);
    expect(env.remoteHost).toBe("https://huggingface.co/");
  });

  it("reports file download progress", async () => {
    const context = ctx();
    pipeline.mockImplementation(async (_task, _model, options) => {
      options.progress_callback({
        status: "progress",
        file: "onnx/model_quantized.onnx",
        progress: 50,
      });
      return extractor;
    });
    await new LocalEmbeddingProvider().embed(["test"], "query", context);
    expect(context.log.info).toHaveBeenCalledWith(
      "download.progress",
      expect.objectContaining({
        progress: 50,
        file: "onnx/model_quantized.onnx",
      }),
    );
  });

  it("bounds the initial wait while allowing a slow shared model load to warm up", async () => {
    vi.useFakeTimers();
    let finish!: (value: typeof extractor) => void;
    pipeline.mockReturnValue(
      new Promise<typeof extractor>((resolve) => {
        finish = resolve;
      }),
    );
    const provider = new LocalEmbeddingProvider();
    const pending = provider.embed(
      ["test"],
      "query",
      ctx({ loadTimeoutMs: 50 }),
    );
    const failure = expect(pending).rejects.toMatchObject({
      code: "embedding_unavailable",
    });
    await vi.advanceTimersByTimeAsync(51);
    await failure;
    finish(extractor);
    await expect(
      provider.embed(["test"], "query", ctx({ loadTimeoutMs: 50 })),
    ).resolves.toEqual([[1, 0]]);
  });
});
