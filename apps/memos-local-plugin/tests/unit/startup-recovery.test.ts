import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(__dirname, "../../core/pipeline/memory-core.ts"),
  "utf8",
);

function initBody(): string {
  const start = source.indexOf("  async function init(): Promise<void> {");
  expect(start, "init() function should be present").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n  function", start + 1);
  expect(end, "init() should be followed by another function").toBeGreaterThan(start);
  return source.slice(start, end);
}

function stripScheduledRecoveryCallbacks(body: string): string {
  return body.replace(
    /scheduleStartupRecovery\([\s\S]*?\n        \}\);/g,
    "scheduleStartupRecovery(<background task>);",
  );
}

describe("memory-core startup recovery", () => {
  it("does not block init on stale/dirty episode recovery", () => {
    const synchronousInitBody = stripScheduledRecoveryCallbacks(initBody());

    expect(synchronousInitBody).not.toContain("await recoverOpenEpisodesAsSessionEnd(stale)");
    expect(synchronousInitBody).not.toContain("await recoverDirtyClosedEpisodes(dirtyClosed)");
    expect(initBody()).toContain("scheduleStartupRecovery(\"startup.open_recovery\"");
    expect(initBody()).toContain("scheduleStartupRecovery(\"startup.dirty_closed_recovery\"");
  });
});
