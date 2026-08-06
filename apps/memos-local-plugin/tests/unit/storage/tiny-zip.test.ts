/**
 * tiny-zip — round-trip smoke test.
 *
 * The skill download endpoint hands out a one-file ZIP built by
 * `core/util/tiny-zip.ts`. We don't pull in adm-zip just to verify
 * the bytes; instead we parse the local-file header and compare the
 * embedded payload against the original input. That's enough to catch
 * the "we shipped a corrupt ZIP" failure mode without depending on a
 * specific ZIP reader.
 */

import { describe, expect, it } from "vitest";

import { buildSingleFileZip, computeCrc32 } from "../../../core/util/tiny-zip.js";

describe("core/util/tiny-zip", () => {
  it("produces a buffer that starts with the PKZIP local-file magic", () => {
    const buf = buildSingleFileZip("SKILL.md", "# hello\n");
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("embeds the same content we put in", () => {
    const payload = "# my skill\n\nuse this when foo bar baz\n";
    const buf = buildSingleFileZip("SKILL.md", payload);

    // Local file header is 30 bytes + filename + extra. We hard-coded
    // extra=0, name="SKILL.md" (8 bytes), so payload starts at 38.
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const storedSize = buf.readUInt32LE(18);
    const start = 30 + nameLen + extraLen;
    const stored = buf.subarray(start, start + storedSize);

    expect(stored.toString("utf8")).toBe(payload);
  });

  it("crc32 matches the well-known value for an empty input", () => {
    expect(computeCrc32(new Uint8Array())).toBe(0);
  });

  it("crc32 matches the well-known value for ASCII '123456789'", () => {
    expect(computeCrc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
