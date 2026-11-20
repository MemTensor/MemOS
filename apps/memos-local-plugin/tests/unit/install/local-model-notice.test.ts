import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

describe("local embedding model download notice", () => {
  it.each(["install.sh", "install.ps1"])("warns during %s installation", (file) => {
    const source = readFileSync(path.join(repoRoot, file), "utf8");

    expect(source).toContain("Local MiniLM model weights are not bundled");
    expect(source).toContain("Hugging Face");
    expect(source).toContain("23 MB");
  });

  it("explains the first-use download in the Viewer", () => {
    const source = readFileSync(path.join(repoRoot, "viewer/src/stores/i18n.ts"), "utf8");

    expect(source).toContain("first test or use downloads about 23 MB from Hugging Face");
    expect(source).toContain("首次测试或使用时需从 Hugging Face 下载约 23 MB");
    expect(source).not.toContain("The bundled embedder");
    expect(source).not.toContain("插件内置嵌入模型");
  });
});
