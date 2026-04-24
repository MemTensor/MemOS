import { beforeAll, describe, expect, it } from "vitest";

import { embedSteps } from "../../../core/capture/embedder.js";
import type { NormalizedStep } from "../../../core/capture/types.js";
import { initTestLogger } from "../../../core/logger/index.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

function step(partial: Partial<NormalizedStep>): NormalizedStep {
  return {
    key: partial.key ?? "k",
    ts: partial.ts ?? 1_000,
    userText: partial.userText ?? "",
    agentText: partial.agentText ?? "",
    toolCalls: partial.toolCalls ?? [],
    rawReflection: null,
    depth: 0,
    isSubagent: false,
    meta: {},
    truncated: partial.truncated ?? false,
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
