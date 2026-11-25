import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DshDiagnostics } from "../../../adapters/deepseek-harness/diagnostics.js";

describe("DSH diagnostic recorder", () => {
  it("writes isolated structured events and excludes prompts and credentials", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "memos-diag-"));
    const a = new DshDiagnostics(dir), b = new DshDiagnostics(dir);
    try {
      a.record("llm.start", { provider: "synthetic", model: "test-model", op: "capture.summarize", registeredProviders: ["synthetic"], prompt: "DO_NOT_EXPORT", apiKey: "DO_NOT_EXPORT", messages: ["DO_NOT_EXPORT"] });
      expect(a.file).not.toBe(b.file);
      const text = readFileSync(a.file, "utf8");
      expect(text).not.toContain("DO_NOT_EXPORT");
      const records = text.trim().split("\n").map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ event: "llm.start", provider: "synthetic", op: "capture.summarize", registeredProviders: ["synthetic"] });
      expect(records.at(-1)).toHaveProperty("runId");
      expect(records.at(-1)).toHaveProperty("pid");
    } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("separates successful filter latency from timeouts and tracks unfinished captures", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "memos-diag-"));
    const d = new DshDiagnostics(dir);
    try {
      d.record("filter.result", { outcome: "llm_filtered", attempted: true, durationMs: 100, candidateCount: 5 });
      d.record("filter.result", { outcome: "llm_failed_safe_cutoff", attempted: true, durationMs: 2000, errorCode: "LLM_TIMEOUT", candidateCount: 5 });
      d.record("filter.result", { outcome: "below_threshold", attempted: false, durationMs: 0 });
      d.record("filter.result", { probe: true, outcome: "llm_filtered", attempted: true, durationMs: 4000 });
      d.record("llm.started", { callId: "pending-call" });
      d.record("capture.queued", { sessionId: "synthetic-session", turn: 1 });
      expect(d.snapshot()).toMatchObject({ probeCalls: 1, pendingLlmCount: 1, filters: { calls: 3, attempted: 2, succeeded: 1, failed: 1, skipped: 1, successfulLatencyMs: { samples: 1, p50: 100, p95: 100 } }, captures: { queued: 1, committed: 0, pending: 1 } });
      d.record("llm.failed", { callId: "pending-call", errorCode: "NO_ADAPTER" });
      expect(d.snapshot()).toMatchObject({ pendingLlmCount: 0 });
      d.record("capture.committed", { sessionId: "synthetic-session", turn: 1, traceId: "synthetic-trace" });
      expect(d.snapshot()).toMatchObject({ captures: { queued: 1, committed: 1, pending: 0 } });
    } finally { d.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps an exit-time snapshot and removes only its own lifecycle listeners", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "memos-diag-"));
    const before = process.listenerCount("exit");
    const d = new DshDiagnostics(dir);
    try {
      expect(process.listenerCount("exit")).toBe(before + 1);
      d.record("viewer.unavailable", { errorCode: "EADDRINUSE", viewerAvailable: false, failOnStartupError: false });
      expect(d.snapshot()).toMatchObject({ viewerAvailable: false });
      d.close();
      expect(process.listenerCount("exit")).toBe(before);
      expect(readFileSync(d.file, "utf8")).toContain('"event":"diagnostics.closed"');
    } finally { d.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
