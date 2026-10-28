import { describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import {
  createDeepSeekHarnessBridge,
  extractDeepSeekHarnessLlmRoute,
  type DshSessionLike,
  type DshUserMessageLike,
} from "../../../adapters/deepseek-harness/bridge.js";
import { DeepSeekHarnessLlmRouteContext } from "../../../adapters/deepseek-harness/host-llm.js";

function userMessage(text: string): DshUserMessageLike {
  return {
    id: `user-${text}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function recallMessage(text: string): DshUserMessageLike {
  return {
    id: `recall-${text.length}`,
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: "plugin",
      plugin: "memos-local-memory",
      form: "recall",
    },
  };
}

function makeCore(overrides: Partial<MemoryCore> = {}): MemoryCore {
  return {
    init: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    health: vi.fn(),
    openSession: vi.fn(async ({ sessionId }) => sessionId ?? "opened-session"),
    closeSession: vi.fn(async () => undefined),
    openEpisode: vi.fn(async () => "fallback-episode"),
    closeEpisode: vi.fn(async () => undefined),
    onTurnStart: vi.fn(async (turn) => ({
      query: {
        agent: turn.agent,
        namespace: turn.namespace,
        sessionId: "routed-session",
        episodeId: "episode-1",
        query: turn.userText,
      },
      hits: [],
      injectedContext: "The user prefers concise technical answers.",
      tierLatencyMs: { tier1: 1, tier2: 2, tier3: 3 },
    })),
    prepareTurn: vi.fn(async () => ({
      sessionId: "routed-session",
      episodeId: "episode-1",
    })),
    onTurnEnd: vi.fn(async () => ({ traceId: "trace-1", episodeId: "episode-1" })),
    searchMemory: vi.fn(async (query) => ({
      query,
      hits: [],
      injectedContext: "The user prefers concise technical answers.",
      tierLatencyMs: { tier1: 1, tier2: 2, tier3: 3 },
    })),
    recordToolOutcome: vi.fn(),
    ...overrides,
  } as unknown as MemoryCore;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs = 50,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function makeBridge(core: MemoryCore, warnings: string[] = []) {
  let now = 1_000;
  return createDeepSeekHarnessBridge({
    core,
    profileId: "web",
    recallEnabled: true,
    captureEnabled: true,
    recallTimeoutMs: 5_000,
    contextMaxChars: 6_000,
    now: () => now++,
    createRecallMessage: recallMessage,
    onWarn: (message) => warnings.push(message),
  });
}

const session: DshSessionLike = {
  id: "dsh-session-a",
  header: { cwd: "/workspace/project" },
};

describe("DeepSeek Harness bridge", () => {
  it("prefers the persisted request route and falls back to agent defaults", () => {
    const routedSession: DshSessionLike = {
      id: "route-session",
      requestHeader: () => ({
        config: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          reasoningEffort: "high",
        },
      }),
    };

    expect(extractDeepSeekHarnessLlmRoute({
      id: routedSession.id,
      session: routedSession,
      options: { provider: "fallback", model: "fallback-model" },
    })).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      sessionId: routedSession.id,
    });

    const fallbackSession: DshSessionLike = { id: "fallback-session" };
    expect(extractDeepSeekHarnessLlmRoute({
      id: fallbackSession.id,
      session: fallbackSession,
      options: { provider: "openai", model: "gpt-test" },
    })).toEqual({
      provider: "openai",
      model: "gpt-test",
      sessionId: fallbackSession.id,
    });
  });

  it("runs recall and capture under the exact per-turn DSH model route", async () => {
    let currentRoute: unknown;
    const observed: unknown[] = [];
    let persistedRoute = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "medium",
    };
    const routedSession: DshSessionLike = {
      id: "routed-session",
      requestHeader: () => ({ config: persistedRoute }),
    };
    const core = makeCore({
      searchMemory: vi.fn(async (query) => {
        observed.push({ phase: "recall", route: currentRoute });
        return {
          query,
          hits: [],
          injectedContext: "",
          tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
        };
      }),
      prepareTurn: vi.fn(async () => {
        observed.push({ phase: "prepare", route: currentRoute });
        return {
          sessionId: routedSession.id,
          episodeId: "episode-route",
        };
      }),
      onTurnEnd: vi.fn(async () => {
        observed.push({ phase: "capture", route: currentRoute });
        return { traceId: "trace-route", episodeId: "episode-route" };
      }),
      closeSession: vi.fn(async () => {
        observed.push({ phase: "close", route: currentRoute });
      }),
    });
    const bridge = createDeepSeekHarnessBridge({
      core,
      profileId: "web",
      recallEnabled: true,
      captureEnabled: true,
      recallTimeoutMs: 5_000,
      contextMaxChars: 6_000,
      createRecallMessage: recallMessage,
      runWithLlmRoute: (route, operation) => {
        const previous = currentRoute;
        currentRoute = route;
        try {
          const result = operation();
          return Promise.resolve(result).finally(() => {
            currentRoute = previous;
          });
        } catch (error) {
          currentRoute = previous;
          throw error;
        }
      },
    });
    const prompt = userMessage("remember the active model route");

    bridge.onSessionEvent(routedSession, {
      type: "turn/start",
      seq: 0,
      time: 100,
      data: { turn: 1 },
    });
    await bridge.beforeStep({
      agent: {
        id: routedSession.id,
        session: routedSession,
        options: { provider: "fallback", model: "fallback-model" },
      },
      messages: [prompt],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [prompt] }));

    persistedRoute = {
      provider: "anthropic",
      model: "claude-test",
      reasoningEffort: "high",
    };
    bridge.onSessionEvent(routedSession, {
      type: "assistant/message",
      seq: 1,
      time: 110,
      data: {
        turn: 1,
        message: {
          content: [{ type: "text", text: "remembered" }],
        },
      },
    });
    bridge.onSessionEvent(routedSession, {
      type: "turn/end",
      seq: 2,
      time: 120,
      data: { turn: 1, reason: { kind: "completed" } },
    });
    await bridge.flush(routedSession.id);
    await bridge.closeSession(routedSession);

    expect(observed).toEqual([
      {
        phase: "recall",
        route: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          reasoningEffort: "medium",
          sessionId: routedSession.id,
        },
      },
      {
        phase: "prepare",
        route: {
          provider: "anthropic",
          model: "claude-test",
          reasoningEffort: "high",
          sessionId: routedSession.id,
        },
      },
      {
        phase: "capture",
        route: {
          provider: "anthropic",
          model: "claude-test",
          reasoningEffort: "high",
          sessionId: routedSession.id,
        },
      },
      {
        phase: "close",
        route: {
          provider: "anthropic",
          model: "claude-test",
          reasoningEffort: "high",
          sessionId: routedSession.id,
        },
      },
    ]);
  });

  it("keeps native and code-dispatch failure repair work in the last session route", async () => {
    const routes = new DeepSeekHarnessLlmRouteContext();
    const observed: Array<{ phase: string; tool?: string; route: unknown }> = [];
    let failureCount = 0;
    let queuedRepair = Promise.resolve();
    const routedSession: DshSessionLike = {
      id: "failure-route-session",
      requestHeader: () => ({
        config: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          reasoningEffort: "high",
        },
      }),
    };
    const core = makeCore({
      recordToolOutcome: vi.fn((outcome) => {
        observed.push({
          phase: "tool-outcome",
          tool: outcome.tool,
          route: routes.current(),
        });
        if (!outcome.success && ++failureCount === 3) {
          // The real feedback subscriber starts its async repair at the same
          // three-failure threshold. Verify that work spawned by this
          // synchronous callback inherits the DSH route scope as well.
          queuedRepair = Promise.resolve().then(() => {
            observed.push({ phase: "queued-repair", route: routes.current() });
          });
        }
      }),
    });
    const bridge = createDeepSeekHarnessBridge({
      core,
      profileId: "web",
      recallEnabled: true,
      captureEnabled: true,
      recallTimeoutMs: 5_000,
      contextMaxChars: 6_000,
      createRecallMessage: recallMessage,
      runWithLlmRoute: (route, operation) => routes.run(route, operation),
    });
    const prompt = userMessage("establish the session route");

    bridge.onSessionEvent(routedSession, {
      type: "turn/start",
      seq: 0,
      time: 100,
      data: { turn: 1 },
    });
    await bridge.beforeStep({
      agent: { id: routedSession.id, session: routedSession },
      messages: [prompt],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [prompt] }));
    bridge.onSessionEvent(routedSession, {
      type: "turn/end",
      seq: 1,
      time: 110,
      data: { turn: 1, reason: { kind: "completed" } },
    });
    await bridge.flush(routedSession.id);

    // No pre-step route is captured for this synthetic restored turn. Tool
    // feedback must still use the last route known for the DSH Session object.
    bridge.onSessionEvent(routedSession, {
      type: "turn/start",
      seq: 2,
      time: 200,
      data: { turn: 2 },
    });
    bridge.onSessionEvent(routedSession, {
      type: "user/message",
      seq: 3,
      time: 201,
      data: userMessage("repair the restored turn"),
    });
    for (let index = 1; index <= 2; index += 1) {
      const callId = `native-failure-${index}`;
      bridge.onSessionEvent(routedSession, {
        type: "tool/call",
        seq: 2 + index * 2,
        time: 200 + index * 10,
        data: { turn: 2, callId, name: "bash", arguments: "{}" },
      });
      bridge.onSessionEvent(routedSession, {
        type: "tool/result",
        seq: 3 + index * 2,
        time: 205 + index * 10,
        data: {
          turn: 2,
          error: { code: "FAILED" },
          message: {
            source: { kind: "tool", callId },
            content: [{ type: "text", text: "failed" }],
          },
        },
      });
    }
    bridge.onSessionEvent(routedSession, {
      type: "tool/code-dispatch-start",
      seq: 7,
      time: 230,
      data: { subCallId: "code-failure", name: "code", arguments: {} },
    });
    bridge.onSessionEvent(routedSession, {
      type: "tool/code-dispatch",
      seq: 8,
      time: 240,
      data: { subCallId: "code-failure", isError: true, content: "failed" },
    });
    bridge.onSessionEvent(routedSession, {
      type: "turn/end",
      seq: 9,
      time: 250,
      data: { turn: 2, reason: { kind: "completed" } },
    });
    await bridge.flush(routedSession.id);
    await queuedRepair;

    const expectedRoute = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      sessionId: routedSession.id,
    };
    expect(observed).toEqual([
      { phase: "tool-outcome", tool: "bash", route: expectedRoute },
      { phase: "tool-outcome", tool: "bash", route: expectedRoute },
      { phase: "tool-outcome", tool: "code", route: expectedRoute },
      { phase: "queued-repair", route: expectedRoute },
    ]);
    expect(routes.current()).toBeUndefined();
  });

  it("recalls every accepted query once and appends context after each query", async () => {
    const core = makeCore();
    const bridge = makeBridge(core);
    // Automatic recall is unconditional: even a greeting is retrieved. There
    // is deliberately no chitchat gate.
    const prompt = userMessage("你好");

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 100,
      data: { turn: 1 },
    });

    const first = await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [prompt],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [prompt] }),
    );
    bridge.onSessionEvent(session, {
      type: "user/message",
      seq: 1,
      time: 101,
      data: prompt,
    });
    const replayedFirstStep = await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [prompt],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [prompt] }),
    );
    const second = await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [],
        turn: 1,
        step: 2,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [] }),
    );

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 2,
      time: 200,
      data: { turn: 2 },
    });
    const followUpPrompt = userMessage("How should I format the answer?");
    const followUp = await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [followUpPrompt],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [followUpPrompt] }),
    );

    expect(core.openSession).not.toHaveBeenCalled();
    expect(core.onTurnStart).not.toHaveBeenCalled();
    expect(core.searchMemory).toHaveBeenCalledTimes(2);
    expect(core.searchMemory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: session.id,
        query: "你好",
        reason: "turn_start",
        namespace: expect.objectContaining({
          agentKind: "deepseek-harness",
          profileId: "web",
          workspacePath: "/workspace/project",
          sessionKey: session.id,
        }),
        deadlineAt: expect.any(Number),
        llmFilterMalformedRetries: 0,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(core.searchMemory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: session.id,
        query: "How should I format the answer?",
        reason: "turn_start",
        deadlineAt: expect.any(Number),
        llmFilterMalformedRetries: 0,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(first.kind).toBe("enter");
    if (first.kind !== "enter") throw new Error("first step was rejected");
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0]).toBe(prompt);
    expect(first.messages[1]).toMatchObject({
      role: "user",
      source: {
        kind: "plugin",
        plugin: "memos-local-memory",
        form: "recall",
      },
      content: [{
        type: "text",
        text: expect.stringContaining("The user prefers concise technical answers."),
      }],
    });
    expect(replayedFirstStep).toEqual({ kind: "enter", messages: [prompt] });
    expect(second).toEqual({ kind: "enter", messages: [] });
    expect(followUp).toMatchObject({
      kind: "enter",
      messages: [followUpPrompt, expect.objectContaining({
        source: expect.objectContaining({ plugin: "memos-local-memory" }),
      })],
    });
  });

  it("recalls a new turn in a resumed session that already has direct-user history", async () => {
    const core = makeCore();
    const bridge = makeBridge(core);
    const resumedSession = {
      id: "resumed-session",
      header: { cwd: "/workspace/project" },
      events: [{
        type: "user/message",
        seq: 1,
        time: 10,
        data: userMessage("a query accepted before this plugin runtime started"),
      }],
    } as unknown as DshSessionLike;
    const prompt = userMessage("next query after resume");

    bridge.onSessionEvent(resumedSession, {
      type: "turn/start",
      seq: 2,
      time: 20,
      data: { turn: 2 },
    });
    const result = await bridge.beforeStep({
      agent: { id: resumedSession.id, session: resumedSession },
      messages: [prompt],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [prompt] }));

    expect(result).toMatchObject({
      kind: "enter",
      messages: [prompt, expect.objectContaining({
        source: expect.objectContaining({ plugin: "memos-local-memory" }),
      })],
    });
    expect(core.searchMemory).toHaveBeenCalledTimes(1);
  });

  it("recalls a fork turn despite inherited direct-user history", async () => {
    const core = makeCore();
    const bridge = makeBridge(core);
    const fork = {
      id: "fork-with-inherited-history",
      header: { cwd: "/workspace/project", seedLength: 1 },
      events: [
        {
          type: "user/message",
          seq: 0,
          time: 10,
          data: userMessage("inherited parent query"),
        },
        {
          type: "user/message",
          seq: 1,
          time: 11,
          data: recallMessage("inherited plugin context does not suppress current recall"),
        },
      ],
    } as unknown as DshSessionLike;
    const prompt = userMessage("first direct query owned by the fork");

    bridge.onSessionEvent(fork, {
      type: "turn/start",
      seq: 2,
      time: 20,
      data: { turn: 1 },
    });
    const result = await bridge.beforeStep({
      agent: { id: fork.id, session: fork },
      messages: [prompt],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [prompt] }));

    expect(core.searchMemory).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "enter",
      messages: [prompt, expect.objectContaining({
        source: expect.objectContaining({ plugin: "memos-local-memory" }),
      })],
    });
  });

  it("recalls a new turn in a fork whose own history already has a direct query", async () => {
    const core = makeCore();
    const bridge = makeBridge(core);
    const resumedFork = {
      id: "fork-with-own-history",
      header: { cwd: "/workspace/project", seedLength: 1 },
      events: [
        {
          type: "user/message",
          seq: 0,
          time: 10,
          data: userMessage("inherited parent query"),
        },
        {
          type: "user/message",
          seq: 1,
          time: 11,
          data: userMessage("query already accepted by this fork"),
        },
      ],
    } as unknown as DshSessionLike;
    const prompt = userMessage("next query after restoring the fork");

    bridge.onSessionEvent(resumedFork, {
      type: "turn/start",
      seq: 2,
      time: 20,
      data: { turn: 2 },
    });
    const result = await bridge.beforeStep({
      agent: { id: resumedFork.id, session: resumedFork },
      messages: [prompt],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [prompt] }));

    expect(result).toMatchObject({
      kind: "enter",
      messages: [prompt, expect.objectContaining({
        source: expect.objectContaining({ plugin: "memos-local-memory" }),
      })],
    });
    expect(core.searchMemory).toHaveBeenCalledTimes(1);
  });

  it("fails open at the adapter recall budget when a core provider ignores cancellation", async () => {
    const stuckRecall = deferred<Awaited<ReturnType<MemoryCore["searchMemory"]>>>();
    const warnings: string[] = [];
    const core = makeCore({
      searchMemory: vi.fn(() => stuckRecall.promise),
    });
    const bridge = createDeepSeekHarnessBridge({
      core,
      profileId: "web",
      recallEnabled: true,
      captureEnabled: true,
      recallTimeoutMs: 5,
      contextMaxChars: 6_000,
      createRecallMessage: recallMessage,
      onWarn: (message) => warnings.push(message),
    });
    const prompt = userMessage("do not wait for a stuck recall provider");

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 100,
      data: { turn: 2 },
    });
    const resultPromise = bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [prompt],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [prompt] }));

    expect(await settlesWithin(resultPromise, 100)).toBe(true);
    await expect(resultPromise).resolves.toEqual({
      kind: "enter",
      messages: [prompt],
    });
    expect(warnings).toEqual([
      expect.stringContaining("DeepSeek Harness recall failed"),
    ]);
    bridge.onSessionEvent(session, {
      type: "user/message",
      seq: 1,
      time: 101,
      data: prompt,
    });

    const followUp = userMessage("each later turn still gets its own bounded recall");
    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 2,
      time: 200,
      data: { turn: 3 },
    });
    await expect(bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [followUp],
      turn: 3,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [followUp] }))).resolves.toEqual({
      kind: "enter",
      messages: [followUp],
    });
    expect(core.searchMemory).toHaveBeenCalledTimes(2);

    // Let the deliberately non-cancellable test double finish so no dangling
    // operation survives the test, just as a real cold model load eventually
    // settles after the adapter has already released the prompt path.
    stuckRecall.resolve({
      query: {
        agent: "deepseek-harness",
        query: "do not wait for a stuck recall provider",
      },
      hits: [],
      injectedContext: "late context must not be injected",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    });
  });

  it("does not let an aborted turn suppress recall for the next accepted query", async () => {
    const abortedRecall = deferred<Awaited<ReturnType<MemoryCore["searchMemory"]>>>();
    const recallStarted = deferred<void>();
    let calls = 0;
    const core = makeCore({
      searchMemory: vi.fn(async (query) => {
        calls += 1;
        if (calls === 1) {
          recallStarted.resolve();
          return abortedRecall.promise;
        }
        return {
          query,
          hits: [],
          injectedContext: "context for the next accepted query",
          tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
        };
      }),
    });
    const bridge = makeBridge(core);
    const cancelled = userMessage("cancel this before DSH accepts it");
    const controller = new AbortController();

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 100,
      data: { turn: 1 },
    });
    const cancelledStep = bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [cancelled],
      turn: 1,
      step: 1,
      signal: controller.signal,
    }, async () => ({ kind: "enter", messages: [cancelled] }));
    await recallStarted.promise;
    controller.abort();
    await expect(cancelledStep).resolves.toEqual({
      kind: "enter",
      messages: [cancelled],
    });
    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 1,
      time: 101,
      data: { turn: 1, reason: { kind: "cancelled" } },
    });

    const retry = userMessage("this is the first query DSH will accept");
    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 2,
      time: 200,
      data: { turn: 2 },
    });
    const result = await bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [retry],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [retry] }));

    expect(core.searchMemory).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      kind: "enter",
      messages: [retry, expect.objectContaining({
        source: expect.objectContaining({ plugin: "memos-local-memory" }),
      })],
    });

    abortedRecall.resolve({
      query: { agent: "deepseek-harness", query: "cancelled" },
      hits: [],
      injectedContext: "late context",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    });
  });

  it("uses pure turn-start search in the foreground and defers lifecycle work", async () => {
    const core = makeCore();
    const bridge = makeBridge(core);
    const prompt = userMessage("Recall without waiting for memory maintenance");

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 100,
      data: { turn: 11 },
    });
    await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [prompt],
        turn: 11,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [prompt] }),
    );

    expect(core.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "deepseek-harness",
        sessionId: session.id,
        query: "Recall without waiting for memory maintenance",
        reason: "turn_start",
        deadlineAt: expect.any(Number),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(core.onTurnStart).not.toHaveBeenCalled();

    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 1,
      time: 110,
      data: { turn: 11, reason: { kind: "completed" } },
    });
    await bridge.flush(session.id);

    expect(core.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnKey: `${session.id}:11`,
      userText: "Recall without waiting for memory maintenance",
      contextHints: expect.objectContaining({
        __memosBackgroundLifecycle: true,
      }),
    }));
    expect(core.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("never joins an earlier capture before admitting the next turn", async () => {
    const captureStarted = deferred<void>();
    const releaseCapture = deferred<void>();
    const core = makeCore({
      onTurnEnd: vi.fn(async () => {
        captureStarted.resolve();
        await releaseCapture.promise;
        return { traceId: "slow-trace", episodeId: "slow-episode" };
      }),
    });
    const bridge = makeBridge(core);

    const firstPrompt = userMessage("first turn");
    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 100,
      data: { turn: 21 },
    });
    await bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [firstPrompt],
      turn: 21,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [firstPrompt] }));
    bridge.onSessionEvent(session, {
      type: "user/message",
      seq: 1,
      time: 105,
      data: firstPrompt,
    });
    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 2,
      time: 110,
      data: { turn: 21, reason: { kind: "completed" } },
    });
    await captureStarted.promise;

    const secondPrompt = userMessage("second turn");
    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 3,
      time: 120,
      data: { turn: 22 },
    });
    const nextStep = bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [secondPrompt],
      turn: 22,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [secondPrompt] }));

    expect(await settlesWithin(nextStep)).toBe(true);
    await expect(nextStep).resolves.toMatchObject({
      kind: "enter",
      messages: [secondPrompt, expect.objectContaining({
        source: expect.objectContaining({ plugin: "memos-local-memory" }),
      })],
    });
    expect(core.searchMemory).toHaveBeenCalledTimes(2);
    expect(core.searchMemory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: "second turn" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    releaseCapture.resolve();
    await bridge.flush(session.id);
  });

  it("never joins unfinished relation or intent routing before admitting the next turn", async () => {
    const routingStarted = deferred<void>();
    const releaseRouting = deferred<void>();
    const core = makeCore({
      prepareTurn: vi.fn(async (turn) => {
        if (turn.userText === "first routed turn") {
          routingStarted.resolve();
          await releaseRouting.promise;
        }
        return {
          sessionId: turn.sessionId,
          episodeId: `episode-${String(turn.userText)}`,
        };
      }),
    });
    const bridge = makeBridge(core);

    const firstPrompt = userMessage("first routed turn");
    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 200,
      data: { turn: 31 },
    });
    await bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [firstPrompt],
      turn: 31,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [firstPrompt] }));
    bridge.onSessionEvent(session, {
      type: "user/message",
      seq: 1,
      time: 205,
      data: firstPrompt,
    });
    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 2,
      time: 210,
      data: { turn: 31, reason: { kind: "completed" } },
    });
    await routingStarted.promise;

    const secondPrompt = userMessage("second turn while routing is pending");
    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 3,
      time: 220,
      data: { turn: 32 },
    });
    const nextStep = bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [secondPrompt],
      turn: 32,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [secondPrompt] }));

    expect(await settlesWithin(nextStep)).toBe(true);
    await expect(nextStep).resolves.toMatchObject({
      kind: "enter",
      messages: [secondPrompt, expect.objectContaining({
        source: expect.objectContaining({ plugin: "memos-local-memory" }),
      })],
    });
    expect(core.searchMemory).toHaveBeenCalledTimes(2);
    expect(core.searchMemory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: "second turn while routing is pending" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    releaseRouting.resolve();
    await bridge.flush(session.id);
  });

  it("serializes prepare and capture work per session without a foreground barrier", async () => {
    const order: string[] = [];
    const core = makeCore({
      prepareTurn: vi.fn(async (turn) => {
        order.push(`prepare:${turn.userText}`);
        return {
          sessionId: turn.sessionId,
          episodeId: `episode-${turn.userText}`,
        };
      }),
      onTurnEnd: vi.fn(async (turn) => {
        order.push(`capture:${turn.episodeId}`);
        return { traceId: `trace-${turn.episodeId}`, episodeId: turn.episodeId! };
      }),
    });
    const bridge = makeBridge(core);

    for (const [turn, text] of [[41, "one"], [42, "two"]] as const) {
      bridge.onSessionEvent(session, {
        type: "turn/start",
        seq: turn * 10,
        time: turn * 10,
        data: { turn },
      });
      bridge.onSessionEvent(session, {
        type: "user/message",
        seq: turn * 10 + 1,
        time: turn * 10 + 1,
        data: userMessage(text),
      });
      bridge.onSessionEvent(session, {
        type: "turn/end",
        seq: turn * 10 + 2,
        time: turn * 10 + 2,
        data: { turn, reason: { kind: "completed" } },
      });
    }

    await bridge.flush(session.id);

    expect(order).toEqual([
      "prepare:one",
      "capture:episode-one",
      "prepare:two",
      "capture:episode-two",
    ]);
    expect(core.prepareTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userText: "one", ts: 410 }),
    );
    expect(core.prepareTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userText: "two", ts: 420 }),
    );
    expect(core.onTurnEnd).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ episodeId: "episode-one", ts: 412 }),
    );
    expect(core.onTurnEnd).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ episodeId: "episode-two", ts: 422 }),
    );
  });

  it("uses the downstream decision text and does not resurrect removed input", async () => {
    const core = makeCore();
    const bridge = makeBridge(core);
    const secret = userMessage("secret that a downstream policy removes");

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 400,
      data: { turn: 4 },
    });
    const removed = await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [secret],
        turn: 4,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [] }),
    );

    expect(removed).toEqual({ kind: "enter", messages: [] });
    expect(core.searchMemory).not.toHaveBeenCalled();
    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 1,
      time: 402,
      data: { turn: 4, reason: { kind: "completed" } },
    });
    await bridge.flush(session.id);
    expect(core.prepareTurn).not.toHaveBeenCalled();
    expect(core.onTurnEnd).not.toHaveBeenCalled();

    const sanitized = userMessage("sanitized request");
    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 2,
      time: 500,
      data: { turn: 5 },
    });
    await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [secret],
        turn: 5,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [sanitized] }),
    );
    bridge.onSessionEvent(session, {
      type: "user/message",
      seq: 3,
      time: 501,
      data: sanitized,
    });

    expect(core.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ query: "sanitized request" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 4,
      time: 502,
      data: { turn: 5, reason: { kind: "completed" } },
    });
    await bridge.flush(session.id);
    expect(core.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      userText: "sanitized request",
    }));
    expect(core.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("captures one terminal turn with structured assistant and tool events", async () => {
    const core = makeCore();
    const bridge = makeBridge(core);
    const prompt = userMessage("Inspect the repository");

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 100,
      data: { turn: 1 },
    });
    await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [prompt],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [prompt] }),
    );
    bridge.onSessionEvent(session, {
      type: "user/message",
      seq: 1,
      time: 110,
      data: prompt,
    });
    bridge.onSessionEvent(session, {
      type: "assistant/message",
      seq: 2,
      time: 120,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          source: { kind: "model", provider: "deepseek", model: "chat" },
          content: [
            { type: "reasoning", text: "I should inspect the files first." },
            { type: "text", text: "I will inspect the repository." },
          ],
        },
      },
    });
    bridge.onSessionEvent(session, {
      type: "tool/call",
      seq: 3,
      time: 130,
      data: {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "bash",
        arguments: "{\"command\":\"rg --files\"}",
      },
    });
    bridge.onSessionEvent(session, {
      type: "tool/result",
      seq: 4,
      time: 145,
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "tool-1",
          role: "user",
          source: { kind: "tool", callId: "call-1" },
          content: [{
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "README.md\npackage.json" }],
            isError: false,
          }],
        },
      },
    });
    bridge.onSessionEvent(session, {
      type: "tool/result",
      seq: 5,
      time: 147,
      surfaceOp: { op: "replace", start: 4, end: 4 },
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "tool-1-redacted",
          role: "user",
          source: { kind: "tool", callId: "call-1" },
          content: [{
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "REDACTED OUTPUT" }],
            isError: false,
          }],
        },
      },
    });
    const terminal = {
      type: "turn/end" as const,
      seq: 6,
      time: 150,
      data: { turn: 1, reason: { kind: "completed" } },
    };
    bridge.onSessionEvent(session, terminal);
    bridge.onSessionEvent(session, terminal);

    await bridge.flush(session.id);

    expect(core.recordToolOutcome).toHaveBeenCalledWith({
      sessionId: "routed-session",
      episodeId: "episode-1",
      tool: "bash",
      success: true,
      errorCode: undefined,
      durationMs: 15,
      ts: 145,
    });
    expect(core.recordToolOutcome).toHaveBeenCalledTimes(1);
    expect(core.onTurnEnd).toHaveBeenCalledTimes(1);
    expect(core.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({
      agent: "deepseek-harness",
      sessionId: "routed-session",
      episodeId: "episode-1",
      agentText: "I will inspect the repository.",
      agentThinking: "I should inspect the files first.",
      toolCalls: [{
        name: "bash",
        input: { command: "rg --files" },
        output: "REDACTED OUTPUT",
        errorCode: undefined,
        toolCallId: "call-1",
        startedAt: 130,
        endedAt: 145,
      }],
      contextHints: expect.objectContaining({
        dshTurn: 1,
        turnEndReason: { kind: "completed" },
      }),
    }));
  });

  it("fails open when recall throws and still captures through a lazy episode", async () => {
    const warnings: string[] = [];
    const core = makeCore({
      searchMemory: vi.fn(async () => {
        throw new Error("retrieval unavailable");
      }),
      prepareTurn: vi.fn(async () => {
        throw new Error("routing unavailable");
      }),
      openEpisode: vi.fn(async () => "lazy-episode"),
    });
    const bridge = makeBridge(core, warnings);
    const prompt = userMessage("Keep working even without memory");

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 200,
      data: { turn: 2 },
    });
    const decision = await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [prompt],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [prompt] }),
    );
    bridge.onSessionEvent(session, {
      type: "assistant/message",
      seq: 1,
      time: 210,
      data: {
        turn: 2,
        step: 1,
        message: {
          id: "assistant-2",
          role: "assistant",
          source: { kind: "model", provider: "deepseek", model: "chat" },
          content: [{ type: "text", text: "Continuing normally." }],
        },
      },
    });
    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 2,
      time: 220,
      data: { turn: 2, reason: { kind: "completed" } },
    });
    await bridge.flush(session.id);

    expect(decision).toEqual({ kind: "enter", messages: [prompt] });
    expect(core.openEpisode).toHaveBeenCalledWith({
      sessionId: session.id,
      userMessage: "Keep working even without memory",
    });
    expect(core.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      episodeId: "lazy-episode",
    }));
    expect(warnings.some((message) => message.includes("retrieval unavailable"))).toBe(true);
  });

  it("drains, closes opened sessions, and shuts the core down on dispose", async () => {
    const core = makeCore();
    const bridge = makeBridge(core);
    const prompt = userMessage("Remember this turn");

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 300,
      data: { turn: 3 },
    });
    await bridge.beforeStep(
      {
        agent: { id: session.id, session },
        messages: [prompt],
        turn: 3,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [prompt] }),
    );

    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 1,
      time: 310,
      data: { turn: 3, reason: { kind: "completed" } },
    });

    await bridge.dispose();

    expect(core.closeSession).toHaveBeenCalledWith("routed-session");
    expect(core.shutdown).toHaveBeenCalledTimes(1);
  });

  it("drains unfinished background routing before closing storage on graceful dispose", async () => {
    const routingStarted = deferred<void>();
    const releaseRouting = deferred<void>();
    const order: string[] = [];
    const core = makeCore({
      prepareTurn: vi.fn(async (turn) => {
        routingStarted.resolve();
        await releaseRouting.promise;
        order.push("prepare");
        return { sessionId: turn.sessionId, episodeId: "dispose-episode" };
      }),
      onTurnEnd: vi.fn(async () => {
        order.push("capture");
        return { traceId: "dispose-trace", episodeId: "dispose-episode" };
      }),
      closeSession: vi.fn(async () => {
        order.push("close");
      }),
      shutdown: vi.fn(async () => {
        order.push("shutdown");
      }),
    });
    const bridge = makeBridge(core);
    const prompt = userMessage("drain this turn");

    bridge.onSessionEvent(session, {
      type: "turn/start",
      seq: 0,
      time: 600,
      data: { turn: 6 },
    });
    await bridge.beforeStep({
      agent: { id: session.id, session },
      messages: [prompt],
      turn: 6,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [prompt] }));
    bridge.onSessionEvent(session, {
      type: "turn/end",
      seq: 1,
      time: 610,
      data: { turn: 6, reason: { kind: "completed" } },
    });
    await routingStarted.promise;

    const disposing = bridge.dispose();
    expect(await settlesWithin(disposing, 20)).toBe(false);
    expect(core.shutdown).not.toHaveBeenCalled();

    releaseRouting.resolve();
    await disposing;

    expect(order).toEqual(["prepare", "capture", "close", "shutdown"]);
  });

  it("isolates restored Session objects that reuse the same persistent id", async () => {
    const core = makeCore({
      prepareTurn: vi.fn(async (turn) => ({
        sessionId: turn.sessionId,
        episodeId: `episode-${String(turn.userText)}`,
      })),
    });
    const bridge = makeBridge(core);
    const oldSession = { id: "restored-id", header: { cwd: "/old" } };
    const newSession = { id: "restored-id", header: { cwd: "/new" } };

    for (const [candidate, turn, text] of [
      [oldSession, 1, "old"] as const,
      [newSession, 2, "new"] as const,
    ]) {
      bridge.onSessionEvent(candidate, {
        type: "turn/start",
        seq: turn,
        time: turn,
        data: { turn },
      });
      await bridge.beforeStep(
        {
          agent: { id: candidate.id, session: candidate },
          messages: [userMessage(text)],
          turn,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ kind: "enter", messages: [userMessage(text)] }),
      );
      bridge.onSessionEvent(candidate, {
        type: "turn/end",
        seq: turn + 10,
        time: turn + 10,
        data: { turn, reason: { kind: "completed" } },
      });
    }
    await bridge.flush("restored-id");

    expect(core.searchMemory).toHaveBeenCalledTimes(2);
    expect(core.searchMemory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: "old" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(core.searchMemory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: "new" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await bridge.closeSession(oldSession);

    expect(core.closeSession).not.toHaveBeenCalledWith("restored-id");

    await bridge.closeSession(newSession);
    expect(core.closeSession).toHaveBeenCalledWith("restored-id");
  });
});
