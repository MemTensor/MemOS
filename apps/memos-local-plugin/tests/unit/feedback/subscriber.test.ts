import { afterEach, describe, it, expect } from "vitest";

import { createFeedbackEventBus } from "../../../core/feedback/events.js";
import {
  attachFeedbackSubscriber,
  type FeedbackSubscriberDeps,
} from "../../../core/feedback/subscriber.js";
import { contextHashOf } from "../../../core/feedback/signals.js";
import { rootLogger } from "../../../core/logger/index.js";
import type {
  EpisodeId,
  SessionId,
} from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import {
  makeFeedbackConfig,
  seedSessionOnly,
  seedTrace,
} from "./_helpers.js";

let handle: TmpDbHandle | null = null;
afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function deps(h: TmpDbHandle, overrides: Partial<FeedbackSubscriberDeps> = {}): FeedbackSubscriberDeps {
  return {
    repos: h.repos,
    llm: null,
    embedder: null,
    bus: createFeedbackEventBus(),
    config: makeFeedbackConfig({
      useLlm: false,
      cooldownMs: 0,
      failureThreshold: 3,
      failureWindow: 5,
    }),
    log: rootLogger.child({ channel: "test.feedback.sub" }),
    ...overrides,
  };
}

function seedScenario(h: TmpDbHandle, sessionId = "s_sub") {
  const episodeId = "ep_sub" as EpisodeId;
  seedSessionOnly(h, sessionId);
  seedTrace(h, {
    episodeId: episodeId as string,
    sessionId,
    agentText: "apk add openssl-dev && pip install cryptography success",
    reflection: "install system deps before pip",
    value: 0.9,
  });
  seedTrace(h, {
    episodeId: episodeId as string,
    sessionId,
    agentText: "pip install cryptography failed: MODULE_NOT_FOUND",
    value: -0.7,
  });
  return { episodeId, sessionId };
}

describe("feedback/subscriber", () => {
  it("runs a repair after a failure burst when threshold is crossed", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { sessionId } = seedScenario(h);
    const bus = createFeedbackEventBus();
    const kinds: string[] = [];
    bus.onAny((e) => kinds.push(e.kind));

    const sub = attachFeedbackSubscriber(deps(h, { bus }));

    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 1,
      reason: "boom",
      sessionId: sessionId as SessionId,
    });
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 2,
      reason: "boom",
      sessionId: sessionId as SessionId,
    });
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 3,
      reason: "boom",
      sessionId: sessionId as SessionId,
    });

    await sub.flush();

    const repairs = h.repos.decisionRepairs.list();
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.contextHash).toBe(contextHashOf("pip.install", "alpine"));

    expect(kinds).toEqual(
      expect.arrayContaining([
        "repair.triggered",
        "repair.persisted",
      ]),
    );
    // Burst context was cleared — peeking must return null.
    expect(sub.signals.peek("pip.install", "alpine")).toBeNull();
    sub.dispose();
  });

  it("does not fire when successes interleave failures below threshold", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { sessionId } = seedScenario(h, "s_inter");
    const sub = attachFeedbackSubscriber(deps(h));

    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 1,
      sessionId: sessionId as SessionId,
    });
    sub.recordToolSuccess({
      toolId: "pip.install",
      context: "alpine",
      step: 2,
      sessionId: sessionId as SessionId,
    });
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 3,
      sessionId: sessionId as SessionId,
    });
    await sub.flush();
    expect(h.repos.decisionRepairs.list()).toHaveLength(0);
    sub.dispose();
  });

  it("submitUserFeedback runs synchronously and persists a repair", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { sessionId } = seedScenario(h, "s_user");
    const sub = attachFeedbackSubscriber(deps(h));

    const result = await sub.submitUserFeedback({
      text: "use apk add openssl-dev instead of pip",
      sessionId: sessionId as SessionId,
      toolId: "pip.install",
      context: "alpine",
    });
    expect(result.skipped).toBe(false);
    expect(result.draft?.preference).toBeTruthy();
    expect(h.repos.decisionRepairs.list()).toHaveLength(1);
    expect(h.repos.decisionRepairs.list()[0]!.contextHash).toBe(
      contextHashOf("pip.install", "alpine"),
    );
    sub.dispose();
  });

  it("runOnce forwards to runRepair directly", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { sessionId } = seedScenario(h, "s_once");
    const sub = attachFeedbackSubscriber(deps(h));

    const r = await sub.runOnce({
      trigger: "manual",
      contextHash: "manual_ctx",
      sessionId: sessionId as SessionId,
      userText: "no, don't do that",
    });
    expect(r.skipped).toBe(false);
    expect(r.draft?.antiPattern).toBeTruthy();
    sub.dispose();
  });

  it("serialises concurrent bursts so jobs don't interleave", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { sessionId } = seedScenario(h, "s_serial");
    const sub = attachFeedbackSubscriber(deps(h));

    const emit = (tool: string, step: number) =>
      sub.recordToolFailure({
        toolId: tool,
        context: "alpine",
        step,
        reason: "b",
        sessionId: sessionId as SessionId,
      });

    // Two tools each hitting threshold quickly.
    emit("pip.install", 1);
    emit("pip.install", 2);
    emit("pip.install", 3);
    emit("pip.build", 1);
    emit("pip.build", 2);
    emit("pip.build", 3);

    await sub.flush();
    const stored = h.repos.decisionRepairs.list();
    expect(stored.length).toBeGreaterThanOrEqual(2);
    // The two bursts should produce different contextHashes.
    const hashes = new Set(stored.map((r) => r.contextHash));
    expect(hashes.has(contextHashOf("pip.install", "alpine"))).toBe(true);
    expect(hashes.has(contextHashOf("pip.build", "alpine"))).toBe(true);
    sub.dispose();
  });

  it("dispose clears signal state", () => {
    handle = makeTmpDb();
    const h = handle;
    seedScenario(h, "s_dispose");
    const sub = attachFeedbackSubscriber(deps(h));
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 1,
    });
    expect(sub.signals.peek("pip.install", "alpine")?.failureCount).toBe(1);
    sub.dispose();
    expect(sub.signals.peek("pip.install", "alpine")).toBeNull();
  });

  it("exposes the underlying signals handle for introspection", () => {
    handle = makeTmpDb();
    const h = handle;
    const sub = attachFeedbackSubscriber(deps(h));
    expect(typeof sub.signals.stats).toBe("function");
    expect(sub.signals.stats().states).toBe(0);
  });

  it("continues processing queued jobs even if one repair throws", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { sessionId } = seedScenario(h, "s_throw");

    let calls = 0;
    const wrapped = {
      ...h.repos,
      decisionRepairs: {
        ...h.repos.decisionRepairs,
        insert: (row: Parameters<typeof h.repos.decisionRepairs.insert>[0]) => {
          calls += 1;
          if (calls === 1) throw new Error("disk full");
          return h.repos.decisionRepairs.insert(row);
        },
      },
    };
    const sub = attachFeedbackSubscriber(deps(h, { repos: wrapped }));

    // First burst → throws, subscriber logs repair.job.failed.
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 1,
      sessionId: sessionId as SessionId,
    });
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 2,
      sessionId: sessionId as SessionId,
    });
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 3,
      sessionId: sessionId as SessionId,
    });
    await sub.flush();
    // First burst attempt failed → nothing persisted yet.
    expect(h.repos.decisionRepairs.list()).toHaveLength(0);

    // Second burst (well outside the window + no interleaved success) succeeds.
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 20,
      sessionId: sessionId as SessionId,
    });
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 21,
      sessionId: sessionId as SessionId,
    });
    sub.recordToolFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 22,
      sessionId: sessionId as SessionId,
    });
    await sub.flush();
    expect(h.repos.decisionRepairs.list().length).toBeGreaterThanOrEqual(1);
    sub.dispose();
  });
});
