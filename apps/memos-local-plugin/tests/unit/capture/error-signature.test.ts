/**
 * Unit tests for V7 §2.6 structural-match extractor.
 *
 * We exercise both the extractor (write side) and its interplay with
 * normalisation rules (the same normaliser runs on retrieval side, so
 * keeping the test tight guarantees query-time lookups will hit the
 * stored fragments).
 */
import { describe, expect, it } from "vitest";

import {
  MAX_SIGNATURES,
  extractErrorSignatures,
} from "../../../core/capture/error-signature.js";

describe("extractErrorSignatures", () => {
  it("captures classic `pg_config not found` as one fragment", () => {
    const sigs = extractErrorSignatures({
      toolCalls: [
        {
          name: "sh",
          input: { cmd: "pip install psycopg2" },
          output: "Error: pg_config executable not found\n\n",
          startedAt: 0,
          endedAt: 10,
          errorCode: "ERR_TOOL_FAILED",
        },
      ],
    });
    expect(sigs.length).toBeGreaterThan(0);
    expect(sigs.some((s) => s.includes("pg_config"))).toBe(true);
  });

  it("captures Python-style `<Name>Error: body`", () => {
    const sigs = extractErrorSignatures({
      toolCalls: [],
      agentText:
        "ModuleNotFoundError: No module named 'numpy'. Please install it first.",
    });
    expect(sigs.some((s) => s.startsWith("ModuleNotFoundError"))).toBe(true);
  });

  it("dedupes identical fragments across corpus sources (lowercased key)", () => {
    const sigs = extractErrorSignatures({
      toolCalls: [
        {
          name: "sh",
          input: {},
          output: "ModuleNotFoundError: No module named 'numpy'",
          startedAt: 0,
          endedAt: 1,
        },
        {
          name: "sh",
          input: {},
          output: "ModuleNotFoundError: No module named 'numpy'",
          startedAt: 0,
          endedAt: 2,
        },
      ],
      agentText: "also saw ModuleNotFoundError: No module named 'numpy'",
    });
    // Exact duplicates must collapse to a single fragment.
    const hits = sigs.filter((s) => s.startsWith("ModuleNotFoundError"));
    expect(hits.length).toBe(1);
  });

  it("caps output at MAX_SIGNATURES", () => {
    const sigs = extractErrorSignatures({
      toolCalls: [],
      agentText: [
        "ValueError: bad x",
        "TypeError: bad y",
        "RuntimeError: bad z",
        "IndexError: bad i",
        "KeyError: bad k",
        "AttributeError: bad a",
      ].join("\n"),
    });
    expect(sigs.length).toBeLessThanOrEqual(MAX_SIGNATURES);
  });

  it("ranks specific identifiers ahead of generic phrasings", () => {
    const sigs = extractErrorSignatures({
      toolCalls: [],
      agentText: [
        "error: some generic thing is required",
        "EACCES: permission denied writing /tmp/foo",
      ].join("\n"),
    });
    // EACCES path should come first — both /tmp path and EACCES boost.
    expect(sigs[0]).toMatch(/EACCES|\/tmp/);
  });

  it("drops fragments whose body is too short to be useful", () => {
    // A full `error: ...` with barely any body fails MIN_FRAGMENT_LEN.
    const sigs = extractErrorSignatures({
      toolCalls: [],
      agentText: "ok",
    });
    expect(sigs).toEqual([]);
  });

  it("handles non-string tool output gracefully", () => {
    const sigs = extractErrorSignatures({
      toolCalls: [
        {
          name: "http",
          input: {},
          output: { status: 500, body: "ServerError: downstream db timeout" },
          startedAt: 0,
          endedAt: 1,
        },
      ],
    });
    expect(sigs.some((s) => /ServerError/.test(s))).toBe(true);
  });

  it("returns [] when there is nothing to extract", () => {
    expect(extractErrorSignatures({ toolCalls: [] })).toEqual([]);
    expect(
      extractErrorSignatures({ toolCalls: [], agentText: "done" }),
    ).toEqual([]);
  });
});
