import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../../../web/src/components/Markdown";

describe("Markdown", () => {
  it("escapes raw HTML and drops unsafe link protocols", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script> [safe](https://example.com) [bad](javascript:alert(1))',
    );

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
  });
});
