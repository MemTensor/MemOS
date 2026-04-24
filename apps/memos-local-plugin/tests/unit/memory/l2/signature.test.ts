/**
 * Unit tests for `core/memory/l2/signature`.
 */

import { describe, expect, it } from "vitest";

import {
  bucketKeyOf,
  componentsOf,
  parseSignature,
  signatureOf,
} from "../../../../core/memory/l2/signature.js";
import type { TraceRow } from "../../../../core/types.js";

import { toolCalls as tc, type PartialToolCall } from "./_helpers.js";

type TraceOverrides = Omit<Partial<TraceRow>, "toolCalls"> & {
  toolCalls?: readonly PartialToolCall[];
};

function mkTrace(partial: TraceOverrides): TraceRow {
  const { toolCalls, ...rest } = partial;
  return {
    id: "tr_1" as TraceRow["id"],
    episodeId: "ep_1" as TraceRow["episodeId"],
    sessionId: "s_1" as TraceRow["sessionId"],
    ts: 0 as TraceRow["ts"],
    userText: "",
    agentText: "",
    reflection: null,
    value: 0.8,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
    ...rest,
    toolCalls: toolCalls ? tc(toolCalls) : [],
  };
}

describe("memory/l2/signature", () => {
  it("uses primary + secondary tag and tool name", () => {
    const tr = mkTrace({
      tags: ["docker", "pip", "cli"],
      toolCalls: [{ name: "pip.install", input: { pkg: "lxml" } }],
    });
    expect(signatureOf(tr)).toBe("docker|pip|pip.install|_");
    const c = componentsOf(tr);
    expect(c.primaryTag).toBe("docker");
    expect(c.secondaryTag).toBe("pip");
    expect(c.tool).toBe("pip.install");
    expect(c.errCode).toBe("_");
  });

  it("extracts SCREAMING_SNAKE error codes from tool output", () => {
    const tr = mkTrace({
      tags: ["docker"],
      toolCalls: [
        {
          name: "pip.install",
          input: {},
          output: "Error: MODULE_NOT_FOUND while compiling wheel",
        },
      ],
    });
    expect(signatureOf(tr)).toBe("docker|_|pip.install|MODULE_NOT_FOUND");
  });

  it("falls back to EXIT_<n> when exit-code style output appears", () => {
    const tr = mkTrace({
      tags: ["docker"],
      toolCalls: [
        { name: "docker.run", input: {}, output: "Process exited with exit code 137" },
      ],
    });
    expect(signatureOf(tr)).toBe("docker|_|docker.run|EXIT_137");
  });

  it("uses `_` placeholders for missing parts", () => {
    const tr = mkTrace({});
    expect(signatureOf(tr)).toBe("_|_|_|_");
  });

  it("parseSignature is the inverse of componentsToSignature", () => {
    const raw = "pip|net|pip.install|NETWORK_REFUSED";
    const c = parseSignature(raw)!;
    expect(c.primaryTag).toBe("pip");
    expect(c.secondaryTag).toBe("net");
    expect(c.tool).toBe("pip.install");
    expect(c.errCode).toBe("NETWORK_REFUSED");
  });

  it("parseSignature returns null for malformed input", () => {
    expect(parseSignature("foo|bar")).toBeNull();
  });

  it("bucketKeyOf collapses tool + secondary, keeping primaryTag + errCode", () => {
    const a = mkTrace({
      tags: ["pip", "alpine"],
      toolCalls: [
        { name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND" },
      ],
    });
    const b = mkTrace({
      tags: ["pip", "debian"],
      toolCalls: [
        { name: "pip3", input: {}, output: "Error: MODULE_NOT_FOUND other" },
      ],
    });
    expect(bucketKeyOf(a)).toBe(bucketKeyOf(b));
  });

  it("reads error codes from the reflection text when tools don't carry them", () => {
    const tr = mkTrace({
      tags: ["plugin"],
      toolCalls: [],
      reflection: "I hit NETWORK_TIMEOUT while downloading the skill",
    });
    const c = componentsOf(tr);
    expect(c.errCode).toBe("NETWORK_TIMEOUT");
  });
});
