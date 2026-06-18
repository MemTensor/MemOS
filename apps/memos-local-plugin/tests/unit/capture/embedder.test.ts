import { beforeAll, describe, expect, it } from "vitest";

import { buildStateText, embedSteps, redactForEmbedding } from "../../../core/capture/embedder.js";
import type { NormalizedStep } from "../../../core/capture/types.js";
import type { EmbedInput, Embedder, EmbedStats } from "../../../core/embedding/types.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type { EmbeddingVector } from "../../../core/types.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

function step(partial: Partial<NormalizedStep>): NormalizedStep {
  return {
    key: partial.key ?? "k",
    ts: partial.ts ?? 1_000,
    userText: partial.userText ?? "",
    agentText: partial.agentText ?? "",
    toolCalls: partial.toolCalls ?? [],
    rawReflection: null,
    depth: partial.depth ?? 0,
    isSubagent: partial.isSubagent ?? false,
    meta: {},
    truncated: partial.truncated ?? false,
  };
}

function recordingEmbedder(texts: string[]): Embedder {
  const stats: EmbedStats = {
    hits: 0,
    misses: 0,
    requests: 0,
    roundTrips: 0,
    failures: 0,
    lastOkAt: null,
    lastError: null,
  };
  const vector = new Float32Array([1]) as EmbeddingVector;
  return {
    dimensions: 1,
    provider: "local",
    model: "recording",
    async embedOne(input: string | EmbedInput): Promise<EmbeddingVector> {
      stats.requests++;
      stats.roundTrips++;
      texts.push(typeof input === "string" ? input : input.text);
      return vector;
    },
    async embedMany(inputs: Array<string | EmbedInput>): Promise<EmbeddingVector[]> {
      stats.requests += inputs.length;
      stats.roundTrips++;
      for (const input of inputs) texts.push(typeof input === "string" ? input : input.text);
      return inputs.map(() => vector);
    },
    stats: () => ({ ...stats }),
    resetCache: () => undefined,
    close: async () => undefined,
  };
}

describe("capture/embedder", () => {
  beforeAll(() => initTestLogger());

  it("returns one vec pair per step in order", async () => {
    const e = fakeEmbedder({ dimensions: 8 });
    const out = await embedSteps(e, [
      step({ userText: "q1", agentText: "a1" }),
      step({ userText: "q2", agentText: "a2", key: "k2" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.summary).toBeInstanceOf(Float32Array);
    expect(out[0]!.action).toBeInstanceOf(Float32Array);
    expect(out[0]!.summary).toHaveLength(8);
    expect(out[1]!.summary).toHaveLength(8);
  });

  it("state and action vectors differ when the texts differ", async () => {
    const e = fakeEmbedder({ dimensions: 16 });
    const out = await embedSteps(e, [step({ userText: "state", agentText: "action" })]);
    // both non-null, but not the same values
    const s = out[0]!.summary!;
    const a = out[0]!.action!;
    expect(s).not.toBeUndefined();
    expect(a).not.toBeUndefined();
    let equal = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== a[i]) {
        equal = false;
        break;
      }
    }
    expect(equal).toBe(false);
  });

  it("empty steps array → empty output, no provider call", async () => {
    const e = fakeEmbedder();
    const out = await embedSteps(e, []);
    expect(out).toEqual([]);
    expect(e.stats().roundTrips).toBe(0);
  });

  it("uses a single round trip for N steps", async () => {
    const e = fakeEmbedder();
    await embedSteps(e, [
      step({ userText: "a", agentText: "b" }),
      step({ userText: "c", agentText: "d" }),
      step({ userText: "e", agentText: "f" }),
    ]);
    expect(e.stats().roundTrips).toBe(1);
  });

  it("summary-only mode embeds one vector per step and leaves action null", async () => {
    const e = fakeEmbedder();
    const out = await embedSteps(
      e,
      [
        step({ userText: "a", agentText: "b" }),
        step({ userText: "c", agentText: "d" }),
      ],
      ["summary a", "summary c"],
      { summaryOnly: true },
    );
    expect(e.stats().requests).toBe(2);
    expect(e.stats().roundTrips).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]!.summary).toBeInstanceOf(Float32Array);
    expect(out[0]!.action).toBeNull();
    expect(out[1]!.summary).toBeInstanceOf(Float32Array);
    expect(out[1]!.action).toBeNull();
  });

  it("uses explicit state and action texts for document embeddings", async () => {
    const texts: string[] = [];
    const e = recordingEmbedder(texts);

    await embedSteps(e, [step({ userText: "display summary", agentText: "old action" })], {
      stateTexts: ["state text"],
      actionTexts: ["action text"],
    });

    expect(texts).toEqual(["state text", "action text"]);
  });

  it("builds redacted state text from user state with compact tool observations", () => {
    const text = buildStateText(step({
      userText: "fix failing npm test",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test" },
        output: "Error: Cannot find module '/repo/src/app.ts'\nOPENAI_API_KEY=sk-AbC123",
        startedAt: 0,
        endedAt: 1,
      }],
    }));

    expect(text).toContain("[user]");
    expect(text).toContain("fix failing npm test");
    expect(text).toContain("[observed]");
    expect(text).toContain("shell");
    expect(text).toContain("Cannot find module");
    expect(text).toContain("/repo/src/app.ts");
    expect(text).not.toContain("sk-AbC123");
  });

  it("redacts only sk- keys made of numbers and letters", () => {
    const text = redactForEmbedding("keys: sk-AbC123 sk-proj-AbC123");

    expect(text).toContain("[REDACTED_KEY]");
    expect(text).not.toContain("sk-AbC123");
    expect(text).toContain("sk-proj-AbC123");
  });

  it("builds distinguishable fallback state for tool-only steps without structural tokens", () => {
    const text = buildStateText(step({
      userText: "",
      agentText: "",
      isSubagent: true,
      depth: 2,
      truncated: true,
      toolCalls: [{
        name: "read_file",
        input: { path: "/repo/package.json" },
        output: "",
        startedAt: 0,
        endedAt: 1,
      }],
    }));

    expect(text).toContain("tool:read_file");
    expect(text).toContain("/repo/package.json");
    expect(text).not.toBe("(empty)");
    expect(text).not.toContain("isSubagent");
    expect(text).not.toContain("depth");
    expect(text).not.toContain("truncated");
  });

  it("tool-call-only step still embeds", async () => {
    const e = fakeEmbedder();
    const out = await embedSteps(e, [
      step({
        userText: "ls",
        agentText: "",
        toolCalls: [{ name: "shell", input: { cmd: "ls" }, output: "ok", startedAt: 0, endedAt: 1 }],
      }),
    ]);
    expect(out[0]!.action).not.toBeNull();
  });

  it("provider failure → null pairs, never throws", async () => {
    const e = fakeEmbedder({ throwWith: new Error("http 500") });
    const out = await embedSteps(e, [step({ userText: "a", agentText: "b" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBeNull();
    expect(out[0]!.action).toBeNull();
  });

  it("empty text step still produces a vector (uses '(empty)' fallback)", async () => {
    const e = fakeEmbedder();
    const out = await embedSteps(e, [step({ userText: "", agentText: "" })]);
    expect(out[0]!.summary).not.toBeNull();
    expect(out[0]!.action).not.toBeNull();
  });
});
