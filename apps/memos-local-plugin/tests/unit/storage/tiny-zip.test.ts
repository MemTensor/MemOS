/**
 * tiny-zip — round-trip smoke test.
 *
 * The skill download endpoint hands out a one-file ZIP built by
 * `core/util/tiny-zip.ts`. We don't pull in adm-zip just to verify
 * the bytes; instead we re-deflate-raw the embedded payload and
 * compare against the original input. That's enough to catch the
 * "we shipped a corrupt ZIP" failure mode without depending on a
 * specific ZIP reader.
 */

import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { buildSingleFileZip, computeCrc32 } from "../../../core/util/tiny-zip.js";

describe("core/util/tiny-zip", () => {
  it("produces a buffer that starts with the PKZIP local-file magic", () => {
    const buf = buildSingleFileZip("SKILL.md", "# hello\n");
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("embeds the same content we put in (after re-inflating the deflate stream)", () => {
    const payload = "# my skill\n\nuse this when foo bar baz\n";
    const buf = buildSingleFileZip("SKILL.md", payload);

    // Local file header is 30 bytes + filename + extra. We hard-coded
    // extra=0, name="SKILL.md" (8 bytes), so payload starts at 38.
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const compressedSize = buf.readUInt32LE(18);
    const start = 30 + nameLen + extraLen;
    const compressed = buf.subarray(start, start + compressedSize);

    const inflated = inflateRawSync(compressed).toString("utf8");
    expect(inflated).toBe(payload);
  });

  it("crc32 matches the well-known value for an empty input", () => {
    expect(computeCrc32(new Uint8Array())).toBe(0);
  });

  it("crc32 matches the well-known value for ASCII '123456789'", () => {
    expect(computeCrc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
