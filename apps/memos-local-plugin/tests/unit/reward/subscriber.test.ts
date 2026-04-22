import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCaptureEventBus } from "../../../core/capture/events.js";
import type { CaptureEvent, CaptureResult } from "../../../core/capture/types.js";
import { attachRewardSubscriber } from "../../../core/reward/subscriber.js";
import type { RewardConfig, RewardInput, RewardResult, UserFeedback } from "../../../core/reward/types.js";

type RunSpy = {
  calls: Array<RewardInput>;
  resolve?: (r: RewardResult) => void;
  reject?: (err: Error) => void;
};

function makeRunner(spy: RunSpy, behavior: "ok" | "pending" | "error" = "ok") {
  return {
    async run(input: RewardInput): Promise<RewardResult> {
      spy.calls.push(input);
      if (behavior === "pending") {
        return new Promise<RewardResult>((resolve, reject) => {
          spy.resolve = resolve;
          spy.reject = reject;
        });
      }
      if (behavior === "error") {
        throw new Error("nope");
      }
      return {
        episodeId: input.episodeId,
        sessionId: "s_1" as unknown as RewardResult["sessionId"],
        rHuman: 0.5,
        humanScore: {
          rHuman: 0.5,
          axes: { goalAchievement: 0, processQuality: 0, userSatisfaction: 0.5 },
          reason: null,
          source: "heuristic",
          model: null,
        },
        feedbackCount: input.feedback.length,
        backprop: {
          updates: [],
          meanAbsValue: 0,
          maxPriority: 0,
          echoParams: { gamma: 0.9, decayHalfLifeDays: 30, now: Date.now() },
        },
        traceIds: [],
        timings: { summary: 0, score: 0, backprop: 0, persist: 0, total: 0 },
        warnings: [],
        startedAt: Date.now() as RewardResult["startedAt"],
        completedAt: Date.now() as RewardResult["completedAt"],
      };
    },
  };
}

function cfg(windowSec = 0): RewardConfig {
  return {
    gamma: 0.9,
    tauSoftmax: 0.5,
    decayHalfLifeDays: 30,
    llmScoring: false,
    implicitThreshold: 0.2,
    feedbackWindowSec: windowSec,
    summaryMaxChars: 2000,
    llmConcurrency: 1,
    minExchangesForCompletion: 0,
    minContentCharsForCompletion: 0,
  };
}

function makeCaptureDone(episodeId: string, traceIds: string[] = ["tr1"]): CaptureEvent {
  return {
    kind: "capture.done",
    result: {
      episodeId: episodeId as unknown as CaptureResult["episodeId"],
      sessionId: "s_1" as unknown as CaptureResult["sessionId"],
      traces: [],
      traceIds: traceIds as unknown as CaptureResult["traceIds"],
      llmCalls: { reflectionSynth: 0, alphaScoring: 0 },
      warnings: [],
      startedAt: 0 as unknown as CaptureResult["startedAt"],
      completedAt: 0 as unknown as CaptureResult["completedAt"],
      stageTimings: { extract: 0, normalize: 0, reflect: 0, alpha: 0, summarize: 0, embed: 0, persist: 0 },
    },
  };
}

function makeFeedback(eid: string): UserFeedback {
  return {
    id: `fb_${eid}` as unknown as UserFeedback["id"],
    episodeId: eid as unknown as UserFeedback["episodeId"],
    sessionId: "s_1" as unknown as UserFeedback["sessionId"],
    traceId: null,
    ts: Date.now() as UserFeedback["ts"],
    channel: "explicit",
    polarity: "positive",
    magnitude: 0.9,
    text: "great",
    rationale: null,
  };
}

describe("reward/subscriber", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers on capture.done and fires after feedbackWindow expires (implicit fallback)", async () => {
    const spy: RunSpy = { calls: [] };
    const bus = createCaptureEventBus();
    const sub = attachRewardSubscriber(bus, makeRunner(spy, "ok"), cfg(5), {});

    bus.emit(makeCaptureDone("ep_A"));
    expect(spy.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_000);
    await sub.drain();

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.trigger).toBe("implicit_fallback");
    expect(spy.calls[0]!.feedback).toHaveLength(0);
    sub.stop();
  });

  it("submitFeedback before window expires fires immediately with explicit trigger", async () => {
    const spy: RunSpy = { calls: [] };
    const bus = createCaptureEventBus();
    const sub = attachRewardSubscriber(bus, makeRunner(spy, "ok"), cfg(10), {});

    bus.emit(makeCaptureDone("ep_B"));
    sub.submitFeedback(makeFeedback("ep_B"));
    // advance past window to prove we don't double-fire
    await vi.advanceTimersByTimeAsync(20_000);
    await sub.drain();

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.trigger).toBe("explicit_feedback");
    expect(spy.calls[0]!.feedback).toHaveLength(1);
    sub.stop();
  });

  it("submitFeedback for unknown episode still triggers a run", async () => {
    const spy: RunSpy = { calls: [] };
    const bus = createCaptureEventBus();
    const sub = attachRewardSubscriber(bus, makeRunner(spy, "ok"), cfg(0), {});

    sub.submitFeedback(makeFeedback("ep_X"));
    await sub.drain();

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.episodeId).toBe("ep_X");
    expect(spy.calls[0]!.trigger).toBe("explicit_feedback");
    sub.stop();
  });

  it("skips capture results with zero traces", async () => {
    const spy: RunSpy = { calls: [] };
    const bus = createCaptureEventBus();
    const sub = attachRewardSubscriber(bus, makeRunner(spy, "ok"), cfg(5), {});

    bus.emit(makeCaptureDone("ep_empty", []));
    await vi.advanceTimersByTimeAsync(10_000);
    await sub.drain();

    expect(spy.calls).toHaveLength(0);
    sub.stop();
  });

  it("feedbackWindowSec=0 disables auto-fallback; only manual/explicit fires", async () => {
    const spy: RunSpy = { calls: [] };
    const bus = createCaptureEventBus();
    const sub = attachRewardSubscriber(bus, makeRunner(spy, "ok"), cfg(0), {});

    bus.emit(makeCaptureDone("ep_C"));
    await vi.advanceTimersByTimeAsync(100_000);
    await sub.drain();
    expect(spy.calls).toHaveLength(0);

    await sub.runManually("ep_C" as unknown as Parameters<typeof sub.runManually>[0], "manual");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.trigger).toBe("manual");
    sub.stop();
  });

  it("onError is called when a background run throws", async () => {
    const spy: RunSpy = { calls: [] };
    const onError = vi.fn();
    const bus = createCaptureEventBus();
    const sub = attachRewardSubscriber(bus, makeRunner(spy, "error"), cfg(1), { onError });

    bus.emit(makeCaptureDone("ep_D"));
    await vi.advanceTimersByTimeAsync(2_000);
    await sub.drain();

    expect(onError).toHaveBeenCalledTimes(1);
    sub.stop();
  });

  it("stop() cancels timers without running pending episodes", async () => {
    const spy: RunSpy = { calls: [] };
    const bus = createCaptureEventBus();
    const sub = attachRewardSubscriber(bus, makeRunner(spy, "ok"), cfg(10), {});

    bus.emit(makeCaptureDone("ep_E"));
    sub.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await sub.drain();

    expect(spy.calls).toHaveLength(0);
  });

  it("pendingCount reports in-flight runs", async () => {
    const spy: RunSpy = { calls: [] };
    const bus = createCaptureEventBus();
    const sub = attachRewardSubscriber(bus, makeRunner(spy, "pending"), cfg(1), {});

    bus.emit(makeCaptureDone("ep_F"));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sub.pendingCount()).toBe(1);

    spy.resolve?.({
      episodeId: "ep_F" as unknown as RewardResult["episodeId"],
      sessionId: "s_1" as unknown as RewardResult["sessionId"],
      rHuman: 0,
      humanScore: {
        rHuman: 0,
        axes: { goalAchievement: 0, processQuality: 0, userSatisfaction: 0 },
        reason: null,
        source: "heuristic",
        model: null,
      },
      feedbackCount: 0,
      backprop: {
        updates: [],
        meanAbsValue: 0,
        maxPriority: 0,
        echoParams: { gamma: 0.9, decayHalfLifeDays: 30, now: Date.now() },
      },
      traceIds: [],
      timings: { summary: 0, score: 0, backprop: 0, persist: 0, total: 0 },
      warnings: [],
      startedAt: Date.now() as RewardResult["startedAt"],
      completedAt: Date.now() as RewardResult["completedAt"],
    });
    await sub.drain();
    expect(sub.pendingCount()).toBe(0);
    sub.stop();
  });
});
