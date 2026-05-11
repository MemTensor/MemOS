import { describe, expect, it } from "vitest";

import {
  isSafeLinkTarget,
  sanitizeDerivedMarkdown,
  sanitizeDerivedText,
} from "../../../core/safety/content.js";

describe("safety/content", () => {
  it("strips unsafe markup and downgrades dangerous markdown links", () => {
    const cleaned = sanitizeDerivedText(
      '<script>alert(1)</script><b>Hello</b> [safe](https://example.com) [bad](javascript:alert(1))',
    );

    expect(cleaned).toBe("Hello [safe](https://example.com) bad");
  });

  it("keeps code-like angle brackets in markdown/body text", () => {
    const cleaned = sanitizeDerivedMarkdown(
      'Use Array<T> and <b>bold</b>, but drop <svg onload=alert(1)> and [bad](javascript:alert(1))',
    );

    expect(cleaned).toContain("Array<T>");
    expect(cleaned).toContain("<b>bold</b>");
    expect(cleaned).not.toContain("<svg");
    expect(cleaned).not.toContain("javascript:");
  });

  it("allows only known-safe link targets", () => {
    expect(isSafeLinkTarget("https://example.com")).toBe(true);
    expect(isSafeLinkTarget("/local/path")).toBe(true);
    expect(isSafeLinkTarget("mailto:user@example.com")).toBe(true);
    expect(isSafeLinkTarget("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkTarget("data:text/html,<script>alert(1)</script>")).toBe(false);
  });
});
