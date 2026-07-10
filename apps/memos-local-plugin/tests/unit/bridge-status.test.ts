import { describe, expect, it } from "vitest";

import { matchesHermesChatCommandLine } from "../../bridge/hermes-process.js";

describe("Hermes chat process detection", () => {
  it("matches the standard Hermes chat command", () => {
    expect(matchesHermesChatCommandLine("hermes chat")).toBe(true);
    expect(matchesHermesChatCommandLine("/usr/local/bin/hermes chat")).toBe(true);
  });

  it("matches global flags before the chat subcommand", () => {
    expect(
      matchesHermesChatCommandLine(
        "/usr/local/lib/hermes-agent/venv/bin/hermes --skills memory-routing chat",
      ),
    ).toBe(true);
    expect(
      matchesHermesChatCommandLine(
        "hermes -m gpt-4.1 --provider openai chat --skills memory-routing",
      ),
    ).toBe(true);
  });

  it("matches gateway sessions and rejects unrelated Hermes commands", () => {
    expect(
      matchesHermesChatCommandLine("hermes --skills memory-routing gateway"),
    ).toBe(true);
    expect(matchesHermesChatCommandLine("hermes dashboard")).toBe(false);
  });
});
