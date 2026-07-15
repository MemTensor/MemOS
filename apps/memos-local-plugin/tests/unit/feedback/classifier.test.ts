import { describe, it, expect } from "vitest";

import { classifyFeedback } from "../../../core/feedback/classifier.js";

describe("feedback/classifier", () => {
  it("returns unknown on empty input", () => {
    expect(classifyFeedback("")).toMatchObject({
      shape: "unknown",
      confidence: 0,
    });
    expect(classifyFeedback("   \n   ")).toMatchObject({
      shape: "unknown",
      confidence: 0,
    });
  });

  it("detects positive affirmations", () => {
    for (const raw of [
      "Great, that works!",
      "Perfect",
      "Thanks",
      "yes",
      "好的",
      "完美",
    ]) {
      expect(classifyFeedback(raw).shape).toBe("positive");
    }
  });

  it("detects negative rejections", () => {
    for (const raw of [
      "No, that's wrong",
      "Don't do that",
      "stop that",
      "nope",
      "不对",
      "别这样",
    ]) {
      expect(classifyFeedback(raw).shape).toBe("negative");
    }
  });

  it("extracts prefer/avoid from 'use X instead of Y'", () => {
    const r = classifyFeedback("Use uv instead of pip");
    expect(r.shape).toBe("preference");
    expect(r.prefer).toBe("uv");
    expect(r.avoid).toBe("pip");
  });

  it("extracts prefer/avoid from 'prefer X over Y'", () => {
    const r = classifyFeedback("prefer yarn over npm");
    expect(r.shape).toBe("preference");
    expect(r.prefer).toBe("yarn");
    expect(r.avoid).toBe("npm");
  });

  it("extracts Chinese 用 X 代替 Y", () => {
    const r = classifyFeedback("用 poetry 代替 pip");
    expect(r.shape).toBe("preference");
    expect(r.prefer).toBe("poetry");
    expect(r.avoid).toBe("pip");
  });

  it("detects soft preference without a capture group", () => {
    const r = classifyFeedback("i prefer bare metal");
    expect(r.shape).toBe("preference");
    expect(r.prefer).toBeUndefined();
  });

  it("detects next-time instruction as preference", () => {
    const r = classifyFeedback("next time use apt-get");
    expect(r.shape).toBe("preference");
    expect(r.prefer).toContain("apt-get");
  });

  it("identifies imperative instructions", () => {
    // NOTE: phrases that start with "also …" or "must …" now classify as
    // `constraint` instead of `instruction` — the constraint signal is
    // stronger per V7 §2.4.3. Kept a short list of pure imperatives that
    // do NOT match the constraint regex.
    for (const raw of [
      "Run the tests now",
      "Install pandas",
      "then delete the file",
    ]) {
      expect(classifyFeedback(raw).shape).toBe("instruction");
    }
  });

  it("falls back to unknown on neutral commentary", () => {
    const r = classifyFeedback("the weather is warm today");
    expect(r.shape).toBe("unknown");
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("carries the raw text through for downstream UI", () => {
    const r = classifyFeedback("  Use uv instead of pip.  ");
    expect(r.text).toBe("Use uv instead of pip.");
  });

  // ─── V7 §2.4.3 — new shapes ───────────────────────────────────────────

  it("detects correction via 'it should be X'", () => {
    const r = classifyFeedback("it should be 42, not 41");
    expect(r.shape).toBe("correction");
    expect(r.correction).toContain("42");
  });

  it("detects Chinese correction 应该是 / 不是…是…", () => {
    const r1 = classifyFeedback("应该是 utf-8 编码");
    expect(r1.shape).toBe("correction");
    expect(r1.correction).toContain("utf-8");

    const r2 = classifyFeedback("不是 Python3.9,是 3.11");
    expect(r2.shape).toBe("correction");
    expect(r2.correction).toContain("3.11");
  });

  it("soft correction via 'not quite' / 'close but'", () => {
    for (const raw of ["not quite", "close but", "almost"]) {
      expect(classifyFeedback(raw).shape).toBe("correction");
    }
  });

  it("detects constraint via 'also'/'must'/'make sure'", () => {
    const a = classifyFeedback("also log every request");
    expect(a.shape).toBe("constraint");
    expect(a.constraint).toContain("log every request");

    const b = classifyFeedback("make sure to handle null inputs");
    expect(b.shape).toBe("constraint");
    expect(b.constraint).toContain("handle null inputs");

    const c = classifyFeedback("it must keep backwards compatibility");
    expect(c.shape).toBe("constraint");
    expect(c.constraint).toContain("keep backwards compatibility");
  });

  it("detects Chinese constraint 还要 / 别忘了 / 必须", () => {
    const r = classifyFeedback("还要加一个超时参数");
    expect(r.shape).toBe("constraint");
    expect(r.constraint).toContain("超时");
  });

  it("detects confusion via 'what do you mean' / '???'", () => {
    for (const raw of [
      "what do you mean by that?",
      "why did you import this package",
      "I don't understand",
      "???",
      "什么意思?",
      "没看懂",
    ]) {
      expect(classifyFeedback(raw).shape).toBe("confusion");
    }
  });

  it("preference still wins over correction when both apply", () => {
    // "use X instead of Y" is a preference; the text "should be X not Y"
    // would look like a correction, but preference patterns run first.
    const r = classifyFeedback("use yarn instead of npm");
    expect(r.shape).toBe("preference");
    expect(r.prefer).toBe("yarn");
  });
});
