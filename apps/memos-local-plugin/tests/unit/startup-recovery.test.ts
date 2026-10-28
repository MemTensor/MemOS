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

function shutdownBody(): string {
  const start = source.indexOf("  async function shutdown(): Promise<void> {");
  expect(start, "shutdown() function should be present").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n  async function health", start + 1);
  expect(end, "shutdown() should be followed by health()").toBeGreaterThan(start);
  return source.slice(start, end);
}

function stripBackgroundRecoveryCallback(body: string): string {
  return body.replace(
    /startupRecoveryPromise = \(async \(\) => \{[\s\S]*?\n\s*\}\)\(\);/g,
    "startupRecoveryPromise = <background task>;",
  );
}

describe("memory-core startup recovery", () => {
  it("does not block init on stale/dirty episode recovery", () => {
    const body = initBody();
    const synchronousInitBody = stripBackgroundRecoveryCallback(body);

    expect(synchronousInitBody).not.toContain("await recoverOpenEpisodesAsSessionEnd(stale)");
    expect(synchronousInitBody).not.toContain("await recoverDirtyClosedEpisodes(dirtyClosed)");
    expect(body).toContain("startupRecoveryPromise = (async () => {");
    expect(body).not.toContain("await startupRecoveryPromise");
  });

  it("cancels and reports startup recovery that exceeds the shutdown grace", () => {
    const body = shutdownBody();

    expect(body).toContain('log.warn("startup_recovery.shutdown_timeout"');
    expect(body).toContain("startupRecoveryCancelled = true");
    expect(body).toContain("flushGraceMs: 0");
  });
});
