import { beforeAll, describe, expect, it } from "vitest";

import { attachCaptureSubscriber } from "../../../core/capture/subscriber.js";
import type { CaptureRunner } from "../../../core/capture/capture.js";
import type { CaptureInput, CaptureResult } from "../../../core/capture/types.js";
import { createSessionEventBus } from "../../../core/session/events.js";
import { retrievalFor } from "../../../core/session/heuristics.js";
import type {
  EpisodeCloseReason,
  EpisodeSnapshot,
  SessionEventBus,
} from "../../../core/session/types.js";
import type { EpochMs, EpisodeId, SessionId, TraceId } from "../../../core/types.js";
import { initTestLogger } from "../../../core/logger/index.js";

function snap(id: string): EpisodeSnapshot {
  return {
    id: id as EpisodeId,
    sessionId: "se_1" as SessionId,
    startedAt: 1_000 as EpochMs,
    endedAt: 2_000 as EpochMs,
    status: "closed",
    rTask: null,
    turnCount: 2,
    turns: [
      { id: "t_1", role: "user", content: "q", ts: 1_000 as EpochMs, meta: {} },
      { id: "t_2", role: "assistant", content: "a", ts: 1_100 as EpochMs, meta: {} },
    ],
    traceIds: [],
    meta: {},
    intent: {
      kind: "task",
      confidence: 1,
      reason: "t",
      retrieval: retrievalFor("task"),
      signals: [],
    },
  };
}

function emptyResult(episodeId: string): CaptureResult {
  return {
    episodeId: episodeId as EpisodeId,
    sessionId: "se_1" as SessionId,
    traceIds: [],
    traces: [],
    startedAt: 0 as EpochMs,
    completedAt: 1 as EpochMs,
    stageTimings: { extract: 0, normalize: 0, reflect: 0, alpha: 0, summarize: 0, embed: 0, persist: 0 },
    llmCalls: { reflectionSynth: 0, alphaScoring: 0 },
    warnings: [],
  };
}

function makeRunner(
  impl: (input: CaptureInput) => Promise<CaptureResult>,
): { runner: CaptureRunner; calls: CaptureInput[] } {
  const calls: CaptureInput[] = [];
  const runner: CaptureRunner = {
    async runLite() {
      // Subscriber tests target the topic-end pass; the lite path is a
      // no-op fixture here.
      return emptyResult("");
    },
    async runReflect(input) {
      calls.push(input);
      return impl(input);
    },
  };
  return { runner, calls };
}

function finalize(
  bus: SessionEventBus,
  id: string,
  closedBy: EpisodeCloseReason = "finalized",
): void {
  bus.emit({
    kind: "episode.finalized",
    episode: snap(id),
    closedBy,
  });
}

describe("capture/subscriber", () => {
  beforeAll(() => initTestLogger());

  it("invokes runner on episode.finalized", async () => {
    const bus = createSessionEventBus();
    const { runner, calls } = makeRunner(async (inp) => emptyResult(inp.episode.id));
    const sub = attachCaptureSubscriber(bus, runner);
    finalize(bus, "ep_1");
    await sub.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.episode.id).toBe("ep_1");
    expect(calls[0]!.closedBy).toBe("finalized");
    sub.stop();
  });

  it("skips abandoned episodes when captureAbandoned=false", async () => {
    const bus = createSessionEventBus();
    const { runner, calls } = makeRunner(async (inp) => emptyResult(inp.episode.id));
    const sub = attachCaptureSubscriber(bus, runner, { captureAbandoned: false });
    finalize(bus, "ep_abandoned", "abandoned");
    await sub.drain();
    expect(calls).toHaveLength(0);
    sub.stop();
  });

  it("captures abandoned episodes by default", async () => {
    const bus = createSessionEventBus();
    const { runner, calls } = makeRunner(async (inp) => emptyResult(inp.episode.id));
    const sub = attachCaptureSubscriber(bus, runner);
    finalize(bus, "ep_a", "abandoned");
    await sub.drain();
    expect(calls).toHaveLength(1);
    sub.stop();
  });

  it("onError callback fires when runner rejects", async () => {
    const bus = createSessionEventBus();
    const err = new Error("boom");
    const runner: CaptureRunner = {
      async runLite() {
        return emptyResult("");
      },
      async runReflect() {
        throw err;
      },
    };
    const seenErrors: unknown[] = [];
    const sub = attachCaptureSubscriber(bus, runner, {
      onError: (e) => seenErrors.push(e),
    });
    finalize(bus, "ep_1");
    await sub.drain();
    expect(seenErrors).toHaveLength(1);
    expect(seenErrors[0]).toBe(err);
    sub.stop();
  });

  it("stop() prevents further captures; pending ones still finish", async () => {
    const bus = createSessionEventBus();
    let resolveLater: (r: CaptureResult) => void = () => {};
    const delayed = new Promise<CaptureResult>((res) => {
      resolveLater = res;
    });
    const runner: CaptureRunner = {
      async runLite() {
        return emptyResult("");
      },
      async runReflect(input) {
        return delayed.then(() => ({
          ...emptyResult(input.episode.id),
          traceIds: ["tr_1" as TraceId],
        }));
      },
    };
    const sub = attachCaptureSubscriber(bus, runner);
    finalize(bus, "ep_first");
    expect(sub.pendingCount()).toBe(1);
    sub.stop();
    finalize(bus, "ep_second");
    expect(sub.pendingCount()).toBe(1); // new emit was not subscribed
    resolveLater(emptyResult("ep_first"));
    await sub.drain();
    expect(sub.pendingCount()).toBe(0);
  });

  it("drain() waits for in-flight captures", async () => {
    const bus = createSessionEventBus();
    const order: string[] = [];
    const runner: CaptureRunner = {
      async runLite() {
        return emptyResult("");
      },
      async runReflect(input) {
        await new Promise((r) => setTimeout(r, 5));
        order.push(input.episode.id);
        return emptyResult(input.episode.id);
      },
    };
    const sub = attachCaptureSubscriber(bus, runner);
    finalize(bus, "ep_A");
    finalize(bus, "ep_B");
    expect(order).toEqual([]);
    await sub.drain();
    expect(order.sort()).toEqual(["ep_A", "ep_B"]);
    sub.stop();
  });

  it("ignores non-finalize events", async () => {
    const bus = createSessionEventBus();
    const { runner, calls } = makeRunner(async (inp) => emptyResult(inp.episode.id));
    const sub = attachCaptureSubscriber(bus, runner);
    bus.emit({
      kind: "episode.started",
      episode: snap("ep_1"),
    });
    await sub.drain();
    expect(calls).toHaveLength(0);
    sub.stop();
  });
});
