import { beforeEach, describe, expect, it, vi } from "vitest";

const { pipelineMock } = vi.hoisted(() => ({
  pipelineMock: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineMock,
}));

import {
  __resetLocalExtractorForTests,
  LocalEmbeddingProvider,
} from "../../../core/embedding/providers/local.js";
import type { ProviderCallCtx, ProviderLogger } from "../../../core/embedding/types.js";

type ExtractorResult = { data: Float32Array };
type Extractor = (
  text: string,
  options?: Record<string, unknown>,
) => Promise<ExtractorResult>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const noop = () => {};
const log: ProviderLogger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

function ctx(signal?: AbortSignal): ProviderCallCtx {
  return {
    config: {
      provider: "local",
      model: "test/minilm",
      dimensions: 2,
      endpoint: "",
      apiKey: "",
      openRouter: false,
      cache: { enabled: false, maxItems: 0 },
    },
    log,
    signal,
  };
}

describe("embedding/local abort handling", () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    __resetLocalExtractorForTests();
  });

  it("does not start lazy model loading for an already-aborted request", async () => {
    const controller = new AbortController();
    const reason = new DOMException("request deadline exceeded", "TimeoutError");
    controller.abort(reason);

    const provider = new LocalEmbeddingProvider();
    await expect(provider.embed(["hello"], "query", ctx(controller.signal))).rejects.toBe(reason);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("stops waiting for initial model load but lets the shared warmup finish", async () => {
    const load = deferred<Extractor>();
    pipelineMock.mockReturnValue(load.promise);
    const controller = new AbortController();
    const provider = new LocalEmbeddingProvider();

    const pending = provider.embed(["first"], "query", ctx(controller.signal));
    await vi.waitFor(() => expect(pipelineMock).toHaveBeenCalledTimes(1));

    const reason = new DOMException("request deadline exceeded", "TimeoutError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    const extractor = vi.fn<Extractor>(async () => ({
      data: new Float32Array([0.25, 0.75]),
    }));
    load.resolve(extractor);

    await expect(provider.embed(["second"], "query", ctx())).resolves.toEqual([[0.25, 0.75]]);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for native inference when the request is aborted", async () => {
    const inference = deferred<ExtractorResult>();
    const extractor = vi.fn<Extractor>(() => inference.promise);
    pipelineMock.mockResolvedValue(extractor);
    const controller = new AbortController();
    const provider = new LocalEmbeddingProvider();

    const pending = provider.embed(["slow"], "query", ctx(controller.signal));
    await vi.waitFor(() => expect(extractor).toHaveBeenCalledTimes(1));

    const reason = new DOMException("request deadline exceeded", "TimeoutError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    // Native work is not cancellable, but settling it later must be harmless.
    inference.resolve({ data: new Float32Array([1, 0]) });
    await inference.promise;
  });
});
