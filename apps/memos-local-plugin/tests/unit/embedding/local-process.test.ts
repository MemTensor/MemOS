import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCallCtx } from "../../../core/embedding/types.js";

const { fork, pipeline, osPlatform } = vi.hoisted(() => ({
  fork: vi.fn(),
  pipeline: vi.fn(),
  osPlatform: vi.fn(() => "win32"),
}));
vi.mock("node:child_process", () => ({ fork }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  platform: osPlatform,
}));
vi.mock("@huggingface/transformers", () => ({ pipeline }));
import { LocalEmbeddingProvider } from "../../../core/embedding/providers/local.js";

class FakeChild extends EventEmitter {
  connected = true;
  channel = { ref: vi.fn(), unref: vi.fn() };
  ref = vi.fn();
  unref = vi.fn();
  send = vi.fn(
    (_message: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
      return true;
    },
  );
  kill = vi.fn(() => {
    this.connected = false;
    this.emit("exit", 0, null);
    return true;
  });
}
let children: FakeChild[];
let providers: LocalEmbeddingProvider[];
function provider() {
  const p = new LocalEmbeddingProvider();
  providers.push(p);
  return p;
}
function ctx(signal?: AbortSignal): ProviderCallCtx {
  return {
    config: {
      provider: "local",
      model: "synthetic/model",
      dimensions: 2,
      local: { offline: true },
      openRouter: false,
      cache: { enabled: false, maxItems: 0 },
    },
    signal,
    log: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}
function request(child = children[0]!) {
  return child.send.mock.calls
    .map(([m]) => m as any)
    .find((m) => m.type === "embed");
}
function success(child = children[0]!, vectors = [[1, 0]]) {
  child.emit("message", { type: "result", id: request(child).id, vectors });
}

beforeEach(() => {
  children = [];
  providers = [];
  pipeline.mockReset();
  fork.mockReset();
  fork.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  await Promise.all(providers.map((p) => p.close()));
  vi.unstubAllEnvs();
});

describe("Windows local embedding process isolation", () => {
  it("loads embeddings in a child without importing Transformers into the host", async () => {
    vi.stubEnv("NODE_OPTIONS", "--require host-preload.cjs");
    vi.stubEnv("NODE_PATH", "host-modules");
    const pending = provider().embed(["synthetic"], "query", ctx());
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    const [entry, args, options] = fork.mock.calls[0]!;
    expect(String(entry)).toMatch(/local-process-entry\.(js|ts)$/);
    expect(args).toEqual([]);
    expect(options).toMatchObject({
      windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.NODE_PATH).toBeUndefined();
    expect(pipeline).not.toHaveBeenCalled();
    success();
    await expect(pending).resolves.toEqual([[1, 0]]);
  });

  it("routes concurrent results and progress to the matching caller", async () => {
    const p = provider();
    const a = ctx();
    const b = ctx();
    const first = p.embed(["first"], "query", a);
    const second = p.embed(["second"], "query", b);
    await vi.waitFor(() => expect(children[0]?.send).toHaveBeenCalledTimes(2));
    const messages = children[0]!.send.mock.calls.map(([m]) => m as any);
    children[0]!.emit("message", {
      type: "log",
      id: messages[1].id,
      level: "info",
      message: "download.progress",
      data: { progress: 50 },
    });
    expect(b.log.info).toHaveBeenCalledWith("download.progress", {
      progress: 50,
    });
    children[0]!.emit("message", {
      type: "result",
      id: messages[1].id,
      vectors: [[0, 1]],
    });
    children[0]!.emit("message", {
      type: "result",
      id: messages[0].id,
      vectors: [[1, 0]],
    });
    await expect(first).resolves.toEqual([[1, 0]]);
    await expect(second).resolves.toEqual([[0, 1]]);
  });

  it("does not spawn for an aborted request, and cancels only the matching pending call", async () => {
    const p = provider();
    const controller = new AbortController();
    controller.abort(new Error("expired"));
    await expect(
      p.embed(["skip"], "query", ctx(controller.signal)),
    ).rejects.toThrow("expired");
    expect(fork).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = p.embed(["slow"], "query", ctx(active.signal));
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    active.abort(new Error("cancelled"));
    await rejected;
    expect(children[0]!.send).toHaveBeenCalledWith(
      { type: "cancel", id: request().id },
      expect.any(Function),
    );
    success(); // Late completion must be harmless.
  });

  it("rejects crashed work and starts a fresh process for the next request", async () => {
    const p = provider();
    const pending = p.embed(["first"], "query", ctx());
    const rejected = expect(pending).rejects.toMatchObject({
      code: "embedding_unavailable",
    });
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    children[0]!.emit("exit", 1, null);
    await rejected;
    const next = p.embed(["retry"], "query", ctx());
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    success(children[1]);
    await expect(next).resolves.toEqual([[1, 0]]);
  });

  it("propagates load failures and validates worker vectors", async () => {
    const p = provider();
    const pending = p.embed(["first"], "query", ctx());
    const failed = expect(pending).rejects.toMatchObject({
      code: "embedding_unavailable",
      message: "offline model missing",
    });
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    children[0]!.emit("message", {
      type: "error",
      id: request().id,
      message: "offline model missing",
    });
    await failed;
    const invalid = p.embed(["invalid"], "query", ctx());
    const rejected = expect(invalid).rejects.toMatchObject({
      code: "embedding_unavailable",
    });
    const messages = children[0]!.send.mock.calls
      .map(([m]) => m as any)
      .filter((m) => m.type === "embed");
    children[0]!.emit("message", {
      type: "result",
      id: messages.at(-1).id,
      vectors: [[NaN]],
    });
    await rejected;
  });

  it("rejects startup and IPC errors without loading native code in the host", async () => {
    const p = provider();
    fork.mockImplementationOnce(() => {
      throw new Error("spawn denied");
    });
    await expect(p.embed(["start"], "query", ctx())).rejects.toMatchObject({
      code: "embedding_unavailable",
    });
    fork.mockImplementationOnce(() => {
      const child = new FakeChild();
      children.push(child);
      child.send.mockImplementation((_m, callback) => {
        callback?.(new Error("closed IPC"));
        return false;
      });
      return child;
    });
    await expect(p.embed(["IPC"], "query", ctx())).rejects.toMatchObject({
      code: "embedding_unavailable",
    });
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("shares a process and releases it only after the last provider closes", async () => {
    const a = provider();
    const b = provider();
    const first = a.embed(["a"], "query", ctx());
    const second = b.embed(["b"], "query", ctx());
    await vi.waitFor(() => expect(children[0]?.send).toHaveBeenCalledTimes(2));
    for (const [m] of children[0]!.send.mock.calls)
      children[0]!.emit("message", {
        type: "result",
        id: (m as any).id,
        vectors: [[1, 0]],
      });
    await Promise.all([first, second]);
    await a.close();
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await b.close();
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });
});
