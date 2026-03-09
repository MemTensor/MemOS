import { describe, it, expect } from "vitest";
import { chunkText } from "../src/ingest/chunker";

describe("chunkText", () => {
  it("should extract code blocks as standalone chunks", () => {
    const text = `Here is some context.

\`\`\`python
def hello():
    print("world")
\`\`\`

And more text after the code block that is long enough to be its own chunk.`;

    const chunks = chunkText(text);
    const codeChunk = chunks.find((c) => c.kind === "code_block");
    expect(codeChunk).toBeDefined();
    expect(codeChunk!.content).toContain("def hello()");
  });

  it("should extract error stacks as standalone chunks", () => {
    const text = `Something went wrong.

Error: Connection refused
    at Socket.connect (net.js:1141:16)
    at TCPConnectWrap.afterConnect (net.js:1152:14)

Then we continued.`;

    const chunks = chunkText(text);
    const errorChunk = chunks.find((c) => c.kind === "error_stack");
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.content).toContain("Connection refused");
  });

  it("should split long paragraphs by sentence when over MAX_CHUNK_CHARS", () => {
    // Total length > 3000 so splitOversized will split at sentence boundaries
    const longPara =
      "First sentence here. " +
      "A".repeat(1500) +
      ". " +
      "B".repeat(1500) +
      ". " +
      "Last sentence.";
    const chunks = chunkText(longPara);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should return at least one chunk for non-empty input", () => {
    const chunks = chunkText("Short text but still meaningful enough to chunk.");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("should extract list blocks", () => {
    const text = `Here are some items:

- First item in the list
- Second item in the list
- Third item in the list

End of text with enough padding to be a real chunk on its own line.`;

    const chunks = chunkText(text);
    const listChunk = chunks.find((c) => c.kind === "list");
    expect(listChunk).toBeDefined();
    expect(listChunk!.content).toContain("First item");
  });
});
