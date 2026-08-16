import { describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import type { DeepSeekHarnessLlmRoute } from "../../../adapters/deepseek-harness/host-llm.js";
import { registerDeepSeekHarnessTools } from "../../../adapters/deepseek-harness/tools.js";

function makeHost() {
  const definitions: Array<{
    name: string;
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>;
  }> = [];
  return {
    definitions,
    host: {
      tools: {
        register(definition: typeof definitions[number]) {
          definitions.push(definition);
          return () => undefined;
        },
      },
    },
  };
}

function makeExec(signal = new AbortController().signal) {
  return {
    callId: "tool-call-1",
    name: "memos_search",
    arguments: {},
    signal,
    agent: {
      id: "dsh-session-a",
      options: { provider: "deepseek", model: "deepseek-chat" },
      session: {
        id: "dsh-session-a",
        header: { cwd: "/workspace/project", agentPreset: "standard" },
      },
    },
  };
}

function passThroughRoute<T>(
  _route: DeepSeekHarnessLlmRoute,
  operation: () => Promise<T>,
): Promise<T> {
  return operation();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("DeepSeek Harness memory tools", () => {
  it("registers the six read-oriented MemOS tools", () => {
    const { host, definitions } = makeHost();
    const core = {} as MemoryCore;

    registerDeepSeekHarnessTools(host as never, {
      core,
      profileId: "web",
      maxBodyChars: 1_200,
      currentEpisode: () => undefined,
      runWithLlmRoute: passThroughRoute,
    });

    expect(definitions.map((definition) => definition.name)).toEqual([
      "memos_search",
      "memos_get",
      "memos_timeline",
      "memos_environment",
      "memos_skill_list",
      "memos_skill_get",
    ]);
  });

  it("scopes memos_search to the calling DSH session when requested", async () => {
    const { host, definitions } = makeHost();
    const searchMemory = vi.fn(async () => ({
      query: { agent: "deepseek-harness", query: "formatting" },
      hits: [{
        tier: 2 as const,
        refKind: "trace" as const,
        refId: "trace-1",
        score: 0.91,
        snippet: "Use concise technical answers.",
      }],
      injectedContext: "Use concise technical answers.",
      tierLatencyMs: { tier1: 1, tier2: 1, tier3: 1 },
    }));
    const core = { searchMemory } as unknown as MemoryCore;
    const seenRoutes: DeepSeekHarnessLlmRoute[] = [];
    registerDeepSeekHarnessTools(host as never, {
      core,
      profileId: "web",
      maxBodyChars: 1_200,
      searchTimeoutMs: 3_000,
      now: () => 10_000,
      currentEpisode: () => "episode-1",
      runWithLlmRoute: (route, operation) => {
        seenRoutes.push(route);
        return operation();
      },
    });

    const tool = definitions.find((definition) => definition.name === "memos_search");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { query: "formatting", maxResults: 3, sessionScope: true },
      makeExec(),
    );

    expect(searchMemory).toHaveBeenCalledWith(
      {
        agent: "deepseek-harness",
        namespace: {
          agentKind: "deepseek-harness",
          profileId: "standard",
          profileLabel: "standard",
          workspacePath: "/workspace/project",
          sessionKey: "dsh-session-a",
        },
        sessionId: "dsh-session-a",
        query: "formatting",
        reason: "tool_driven",
        deadlineAt: 13_000,
        llmFilterMalformedRetries: 0,
        topK: { tier1: 3, tier2: 3, tier3: 3 },
      },
      expect.objectContaining({
        foreground: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(seenRoutes).toEqual([{
      provider: "deepseek",
      model: "deepseek-chat",
      sessionId: "dsh-session-a",
    }]);
    expect(result).toMatchObject({
      hits: [{ refId: "trace-1", snippet: "Use concise technical answers." }],
      text: expect.stringContaining("Use concise technical answers."),
    });
  });

  it("hard-fails open at the DSH search budget when core work does not settle", async () => {
    const { host, definitions } = makeHost();
    const stuck = deferred<Awaited<ReturnType<MemoryCore["searchMemory"]>>>();
    const searchMemory = vi.fn(() => stuck.promise);
    registerDeepSeekHarnessTools(host as never, {
      core: { searchMemory } as unknown as MemoryCore,
      profileId: "web",
      maxBodyChars: 1_200,
      searchTimeoutMs: 5,
      currentEpisode: () => undefined,
      runWithLlmRoute: passThroughRoute,
    });

    const tool = definitions.find((definition) => definition.name === "memos_search");
    const result = await tool!.execute({ query: "bounded lookup" }, makeExec());

    expect(result).toMatchObject({
      text: "No relevant memories found.",
      hits: [],
      timedOut: true,
    });
    expect(searchMemory).toHaveBeenCalledTimes(1);

    stuck.resolve({
      query: { agent: "deepseek-harness", query: "bounded lookup" },
      hits: [],
      injectedContext: "late context must not reach the tool result",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    });
  });

  it("records skill use against the active routed episode", async () => {
    const { host, definitions } = makeHost();
    const getSkill = vi.fn(async () => ({
      id: "skill-1",
      name: "repo-review",
      status: "active",
      description: "Review a repository systematically.",
      invocationGuide: "Inspect rules, status, code, and tests in that order.",
      eta: 0.5,
      support: 3,
      gain: 0.4,
    }));
    const core = { getSkill } as unknown as MemoryCore;
    registerDeepSeekHarnessTools(host as never, {
      core,
      profileId: "web",
      maxBodyChars: 1_200,
      currentEpisode: () => "episode-1",
      runWithLlmRoute: passThroughRoute,
    });

    const tool = definitions.find((definition) => definition.name === "memos_skill_get");
    const result = await tool!.execute({ id: "skill-1" }, makeExec());

    expect(getSkill).toHaveBeenCalledWith("skill-1", expect.objectContaining({
      recordUse: true,
      recordTrial: true,
      sessionId: "dsh-session-a",
      episodeId: "episode-1",
      toolCallId: "tool-call-1",
      namespace: expect.objectContaining({ profileId: "standard" }),
    }));
    expect(result).toMatchObject({
      found: true,
      id: "skill-1",
      text: expect.stringContaining("Inspect rules, status, code, and tests"),
    });
  });

  it("does not start memory work after the DSH tool signal is aborted", async () => {
    const { host, definitions } = makeHost();
    const searchMemory = vi.fn();
    registerDeepSeekHarnessTools(host as never, {
      core: { searchMemory } as unknown as MemoryCore,
      profileId: "web",
      maxBodyChars: 1_200,
      currentEpisode: () => undefined,
      runWithLlmRoute: passThroughRoute,
    });
    const controller = new AbortController();
    controller.abort(new Error("turn cancelled"));

    const tool = definitions.find((definition) => definition.name === "memos_search");
    await expect(tool!.execute({ query: "anything" }, makeExec(controller.signal)))
      .rejects.toThrow("turn cancelled");
    expect(searchMemory).not.toHaveBeenCalled();
  });

  it("rolls back earlier tools if a later registration collides", () => {
    const disposed: string[] = [];
    let attempts = 0;
    const host = {
      tools: {
        register(definition: { name: string }) {
          attempts += 1;
          if (attempts === 4) throw new Error("duplicate tool");
          return () => disposed.push(definition.name);
        },
      },
    };

    expect(() => registerDeepSeekHarnessTools(host as never, {
      core: {} as MemoryCore,
      profileId: "web",
      maxBodyChars: 1_200,
      currentEpisode: () => undefined,
      runWithLlmRoute: passThroughRoute,
    })).toThrow("duplicate tool");
    expect(disposed).toEqual(["memos_timeline", "memos_get", "memos_search"]);
  });
});
