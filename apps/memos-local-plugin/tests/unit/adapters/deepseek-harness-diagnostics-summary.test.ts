import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("summarizes each process independently, deduplicates and separates probes from ordinary filters", () => {
  const root = mkdtempSync(resolve(tmpdir(), "dsh-summary-"));
  try {
    const events = [
      { event: "capture.queued", sessionId: "s", turn: 1 },
      { event: "capture.committed", sessionId: "s", turn: 1, traceId: "t" },
      { event: "filter.result", attempted: true, outcome: "llm_filtered", durationMs: 100 },
      { event: "filter.result", attempted: true, outcome: "llm_failed_safe_cutoff", errorCode: "TIMEOUT", durationMs: 2000 },
      { event: "filter.result", attempted: true, outcome: "llm_filtered", probe: true, durationMs: 4000 },
      { event: "capture.queued", sessionId: "s", turn: 2 },
      { event: "dispose.started" },
    ].map((event, i) => ({ runId: "a", pid: 1, seq: i + 1, ...event }));
    writeFileSync(resolve(root, "a.jsonl"), [...events, events[2], { runId: "b", pid: 2, seq: 1, event: "diagnostics.closed" }].map((e) => JSON.stringify(e)).join("\n") + "\npartial");
    const result = JSON.parse(execFileSync(process.execPath, [resolve(import.meta.dirname, "../../../scripts/summarize-dsh-diagnostics.mjs"), root], { encoding: "utf8" }));
    expect(result.parseErrors).toBe(1);
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toMatchObject({ runId: "a", closed: false, disposeStarted: true, disposeFinished: false,
      filters: { attempted: 2, succeeded: 1, failed: 1, successfulLatencyMs: { p50: 100, p95: 100 } },
      probes: { attempted: 1, succeeded: 1, successfulLatencyMs: { p50: 4000 } },
      captures: { queued: 2, committed: 1, pending: [{ sessionId: "s", turn: 2 }] },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
