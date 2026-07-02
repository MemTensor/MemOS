import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

describe("Gemini viewer embedding test", () => {
  it("uses the batch embedding API and current default model", () => {
    const server = fs.readFileSync(path.join(root, "src/viewer/server.ts"), "utf-8");
    const provider = fs.readFileSync(
      path.join(root, "src/embedding/providers/gemini.ts"),
      "utf-8",
    );
    const html = fs.readFileSync(path.join(root, "src/viewer/html.ts"), "utf-8");

    expect(server).toContain("v1beta/models/${geminiModel}:batchEmbedContents");
    expect(server).toContain("const geminiEndpoint = (");
    expect(server).toContain("requests: [{");
    expect(server).toContain("json?.embeddings?.[0]?.values");
    expect(server).not.toContain(":embedContent?key=${apiKey}");
    expect(provider).toContain('cfg.model ?? "gemini-embedding-001"');
    expect(html).toContain("embModel:'gemini-embedding-001'");
  });
});
