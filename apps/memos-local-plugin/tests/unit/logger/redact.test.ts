import { describe, expect, it } from "vitest";

import { Redactor } from "../../../core/logger/redact.js";

function r() {
  return new Redactor({ extraKeys: ["my_secret"], extraPatterns: ["INTERNAL-[A-Z]{8}"] });
}

describe("logger/redact", () => {
  it("masks default secret keys (case-insensitive)", () => {
    const out = r().redact({
      ts: 1, level: "info", kind: "app", channel: "x", msg: "ok",
      data: { Api_Key: "sk-abc", token: "T123", nested: { Authorization: "Bearer abcdefghijklmnopqrstu" } },
    });
    expect((out.data as Record<string, unknown>)["Api_Key"]).toBe("[redacted]");
    expect((out.data as Record<string, unknown>)["token"]).toBe("[redacted]");
    expect(((out.data as Record<string, unknown>)["nested"] as Record<string, unknown>)["Authorization"]).toBe("[redacted]");
    expect(out._redacted).toBe(true);
  });

  it("masks user-defined extra key names", () => {
    const out = r().redact({
      ts: 1, level: "info", kind: "app", channel: "x", msg: "ok",
      data: { my_secret: "shhh", other: 1 },
    });
    expect((out.data as Record<string, unknown>)["my_secret"]).toBe("[redacted]");
    expect((out.data as Record<string, unknown>)["other"]).toBe(1);
  });

  it("masks Bearer tokens, JWTs, OpenAI-style keys, emails", () => {
    const out = r().redact({
      ts: 1, level: "info", kind: "app", channel: "x",
      msg: "look ma a key sk-1234567890abcdefghij and a Bearer abcdefghijklmnopqrstuvwx and jane@example.com",
    });
    expect(out.msg).not.toContain("sk-1234");
    expect(out.msg).not.toContain("Bearer abcdefghij");
    expect(out.msg).not.toContain("jane@example.com");
    expect(out.msg).toMatch(/\[redacted]/);
    expect(out._redacted).toBe(true);
  });

  it("masks user-defined extra patterns", () => {
    const out = r().redact({
      ts: 1, level: "info", kind: "app", channel: "x", msg: "rotate INTERNAL-ABCDEFGH now",
    });
    expect(out.msg).not.toContain("INTERNAL-ABCDEFGH");
    expect(out._redacted).toBe(true);
  });

  it("ignores invalid user patterns instead of crashing", () => {
    const r2 = new Redactor({ extraKeys: [], extraPatterns: ["[unterminated"] });
    expect(() => r2.redact({ ts: 1, level: "info", kind: "app", channel: "x", msg: "hi" })).not.toThrow();
  });

  it("does not mark records that didn't change", () => {
    const out = r().redact({
      ts: 1, level: "info", kind: "app", channel: "x", msg: "nothing to see here", data: { count: 5 },
    });
    expect(out._redacted).toBeUndefined();
  });

  it("redacts inside Errors too", () => {
    const out = r().redact({
      ts: 1, level: "error", kind: "error", channel: "x", msg: "boom",
      err: {
        name: "Error",
        message: "auth failed using Bearer abcdefghijklmnopqrstuvwx",
        details: { token: "X" },
      },
    });
    expect(out.err?.message).toContain("[redacted]");
    expect(out.err?.details?.["token"]).toBe("[redacted]");
  });
});
