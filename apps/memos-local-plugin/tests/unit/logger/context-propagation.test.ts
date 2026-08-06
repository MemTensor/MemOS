import { describe, expect, it } from "vitest";

import { ensureTraceId, getCtx, setCtx, withCtx } from "../../../core/logger/context.js";

describe("logger/context", () => {
  it("withCtx makes ctx visible to async callees", async () => {
    const seen: Array<string | undefined> = [];
    await withCtx({ sessionId: "se_abc" }, async () => {
      seen.push(getCtx()?.sessionId as string | undefined);
      await Promise.resolve();
      seen.push(getCtx()?.sessionId as string | undefined);
    });
    expect(seen).toEqual(["se_abc", "se_abc"]);
  });

  it("nested withCtx merges patches; inner wins on conflicts", async () => {
    await withCtx({ sessionId: "outer", agent: "openclaw" }, async () => {
      await withCtx({ sessionId: "inner" }, () => {
        const c = getCtx()!;
        expect(c.sessionId).toBe("inner");
        expect(c.agent).toBe("openclaw");
      });
      // After inner exits, outer is restored.
      expect(getCtx()?.sessionId).toBe("outer");
    });
  });

  it("ensureTraceId reuses existing or generates a new one inside scope", async () => {
    let firstCallId = "";
    await withCtx({}, async () => {
      firstCallId = ensureTraceId();
      expect(firstCallId).toMatch(/^co_/);
      const second = ensureTraceId();
      expect(second).toBe(firstCallId);
    });
  });

  it("setCtx is a no-op outside a scope (no throw)", () => {
    expect(() => setCtx({ sessionId: "x" })).not.toThrow();
    expect(getCtx()).toBeUndefined();
  });
});
