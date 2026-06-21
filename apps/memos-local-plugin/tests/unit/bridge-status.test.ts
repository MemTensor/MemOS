import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function matchesHermesChatProcess(command: string): boolean {
  const bridgePath = path.resolve(__dirname, "../../bridge.cts");
  const bridgeSource = fs.readFileSync(bridgePath, "utf8");
  const match = bridgeSource.match(
    /const HERMES_CHAT_PROCESS_PATTERN = "(?<pattern>.*)";/,
  );
  expect(match?.groups?.pattern).toBeTruthy();
  const escapedPattern = match!.groups!.pattern;
  const pattern = escapedPattern.replaceAll("\\\\", "\\");
  return new RegExp(pattern).test(command);
}

describe("Hermes chat process detection", () => {
  it("matches the standard Hermes chat command", () => {
    expect(matchesHermesChatProcess("hermes chat")).toBe(true);
    expect(matchesHermesChatProcess("/usr/local/bin/hermes chat")).toBe(true);
  });

  it("matches global flags before the chat subcommand", () => {
    expect(
      matchesHermesChatProcess(
        "/usr/local/lib/hermes-agent/venv/bin/hermes --skills memory-routing chat",
      ),
    ).toBe(true);
    expect(
      matchesHermesChatProcess(
        "hermes -m gpt-4.1 --provider openai chat --skills memory-routing",
      ),
    ).toBe(true);
  });

  it("does not match non-chat Hermes commands", () => {
    expect(matchesHermesChatProcess("hermes dashboard")).toBe(false);
    expect(matchesHermesChatProcess("hermes --skills memory-routing gateway")).toBe(false);
  });
});
