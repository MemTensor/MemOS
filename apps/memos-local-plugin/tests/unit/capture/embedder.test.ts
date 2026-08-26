import { beforeAll, describe, expect, it } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import { embedSteps } from "../../../core/capture/embedder.js";
import type { NormalizedStep } from "../../../core/capture/types.js";
import type { Embedder } from "../../../core/embedding/types.js";
import { initTestLogger, memoryBuffer } from "../../../core/logger/index.js";
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

  it("preserves successful vectors when a neighboring input is rejected", async () => {
    const base = fakeEmbedder({ dimensions: 3 });
    const e: Embedder = {
      ...base,
      async embedManySettled(inputs) {
        return inputs.map((_, index) => index === 1
          ? { ok: false, error: new MemosError("embedding_unavailable", "bad action") }
          : { ok: true, vector: new Float32Array([1, 2, 3]) });
      },
    };

    const out = await embedSteps(e, [step({ userText: "good summary", agentText: "bad action" })]);

    expect(out[0]!.summary).toEqual(new Float32Array([1, 2, 3]));
    expect(out[0]!.action).toBeNull();
    expect(memoryBuffer().tail({ channel: "core.capture.embed", limit: 20 })).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "embed.partial_failed",
        data: expect.objectContaining({ failedCount: 1, inputCount: 2, stepCount: 1 }),
      }),
    );
  });

  it("logs aggregate partial failures in summary-only mode", async () => {
    const base = fakeEmbedder({ dimensions: 3 });
    const e: Embedder = {
      ...base,
      async embedManySettled(inputs) {
        return inputs.map((_, index) => index === 0
          ? { ok: false, error: new MemosError("embedding_unavailable", "bad summary") }
          : { ok: true, vector: new Float32Array([1, 2, 3]) });
      },
    };

    const out = await embedSteps(
      e,
      [step({ userText: "bad" }), step({ userText: "good", key: "k2" })],
      undefined,
      { summaryOnly: true },
    );

    expect(out[0]!.summary).toBeNull();
    expect(out[1]!.summary).toEqual(new Float32Array([1, 2, 3]));
    expect(memoryBuffer().tail({ channel: "core.capture.embed", limit: 20 })).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "embed.partial_failed",
        data: expect.objectContaining({ failedCount: 1, inputCount: 2, stepCount: 2 }),
      }),
    );
  });

  it("reports an all-failed settled batch without calling it a partial failure", async () => {
    const base = fakeEmbedder({ dimensions: 3 });
    const e: Embedder = {
      ...base,
      async embedManySettled(inputs) {
        return inputs.map(() => ({
          ok: false,
          error: new MemosError("embedding_unavailable", "provider unavailable"),
        }));
      },
    };

    const out = await embedSteps(e, [step({ userText: "summary", agentText: "action" })]);

    expect(out[0]!.summary).toBeNull();
    expect(out[0]!.action).toBeNull();
    expect(memoryBuffer().tail({ channel: "core.capture.embed", limit: 20 })).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "embed.failed_all",
        data: expect.objectContaining({ failedCount: 2, inputCount: 2, stepCount: 1 }),
      }),
    );
  });

  it("empty text step still produces a vector (uses '(empty)' fallback)", async () => {
    const e = fakeEmbedder();
    const out = await embedSteps(e, [step({ userText: "", agentText: "" })]);
    expect(out[0]!.summary).not.toBeNull();
    expect(out[0]!.action).not.toBeNull();
  });
});
