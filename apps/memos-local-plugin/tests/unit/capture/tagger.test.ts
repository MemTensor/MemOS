import { describe, expect, it } from "vitest";

import { tagsForEpisode, tagsForStep } from "../../../core/capture/tagger.js";
import type { ScoredStep } from "../../../core/capture/types.js";
import type { EpochMs } from "../../../core/types.js";

function step(partial: Partial<ScoredStep> = {}): ScoredStep {
  return {
    key: "s1",
    ts: (1_700_000_000_000 as unknown) as EpochMs,
    userText: "",
    agentText: "",
    toolCalls: [],
    rawReflection: null,
    depth: 0,
    isSubagent: false,
    meta: {},
    truncated: false,
    reflection: { text: null, alpha: 0, usable: true, source: "none" },
    ...partial,
  };
}

describe("capture/tagger", () => {
  it("derives tags from tool names", () => {
    const tags = tagsForStep(
      step({
        toolCalls: [
          { name: "docker.run", input: {}, startedAt: 0 as EpochMs, endedAt: 0 as EpochMs },
          { name: "pip.install", input: {}, startedAt: 0 as EpochMs, endedAt: 0 as EpochMs },
        ],
      }),
    );
    expect(tags).toContain("docker");
    expect(tags).toContain("pip");
  });

  it("reads keywords from agent text", () => {
    const tags = tagsForStep(
      step({ agentText: "Running postgres queries against the plugin database" }),
    );
    expect(tags).toContain("database");
    expect(tags).toContain("plugin");
  });

  it("absorbs error codes as tags", () => {
    const tags = tagsForStep(
      step({
        toolCalls: [
          {
            name: "http.get",
            input: {},
            errorCode: "NETWORK_REFUSED",
            startedAt: 0 as EpochMs,
            endedAt: 0 as EpochMs,
          },
        ],
      }),
    );
    expect(tags).toContain("http");
    expect(tags).toContain("network");
    expect(tags).toContain("refused");
  });

  it("caps + dedupes tags", () => {
    const spammy = step({
      agentText: "docker docker docker python python typescript plugin auth test",
    });
    const tags = tagsForStep(spammy);
    expect(tags.filter((t) => t === "docker").length).toBe(1);
    expect(tags.length).toBeLessThanOrEqual(8);
  });

  it("tagsForEpisode merges multiple steps", () => {
    const a = step({ agentText: "docker stuff" });
    const b = step({ key: "b", agentText: "typescript code" });
    const merged = tagsForEpisode([a, b]);
    expect(merged).toContain("docker");
    expect(merged).toContain("typescript");
  });
});
