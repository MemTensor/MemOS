import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redactor } from "../../core/logger/redact.js";
import type { DiagnosticSink } from "../../core/util/diagnostics.js";

const FIELDS = new Set([
  "op", "phase", "scope", "role", "status", "callId", "requestId", "sessionId", "episodeId", "turn", "traceId", "hostSeq", "hostTime", "pendingLlmCount",
  "provider", "model", "registeredProviders", "routePresent", "errorCode", "errorName",
  "timeoutMs", "remainingMs", "durationMs", "candidateCount", "kept", "dropped", "outcome", "attempted",
  "success", "reason", "pendingCount", "queueDepth", "exitCode", "viewerEnabled", "viewerAvailable",
  "viewerPort", "failOnStartupError", "lightweightMemory", "nodeVersion", "platform", "arch", "pluginVersion", "probe",
]);

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

/** One opt-in recorder per adapter instance, including when Viewer cannot start. */
export class DshDiagnostics {
  readonly runId = randomUUID();
  readonly file: string;
  private seq = 0;
  private bytes = 0;
  private closed = false;
  private fileErrors = 0;
  private truncated = false;
  private viewerAvailable: boolean | null = null;
  private readonly redactor = new Redactor({ extraKeys: [], extraPatterns: [] });
  private readonly pending = new Map<string, { sessionId: unknown; turn: unknown }>();
  private readonly pendingLlm = new Set<string>();
  private readonly filters = { calls: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  private readonly outcomes: Record<string, number> = {};
  private readonly errors: Record<string, number> = {};
  private readonly successfulLatencies: number[] = [];
  private readonly captures = { queued: 0, committed: 0, failed: 0 };
  private probeCalls = 0;
  private readonly onExit = (exitCode: number): void => this.record("process.exit", { exitCode, pendingCount: this.pending.size, pendingLlmCount: this.pendingLlm.size });
  private readonly onBeforeExit = (exitCode: number): void => this.record("process.before_exit", { exitCode, pendingCount: this.pending.size, pendingLlmCount: this.pendingLlm.size });

  constructor(logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
    this.file = join(logsDir, `dsh-diagnostics-${process.pid}-${this.runId}.jsonl`);
    writeFileSync(this.file, "", { flag: "wx", mode: 0o600 });
    process.once("exit", this.onExit);
    process.once("beforeExit", this.onBeforeExit);
    this.record("diagnostics.started", { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch });
  }

  readonly record: DiagnosticSink = (event, input): void => {
    if (this.closed) return;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!FIELDS.has(key)) continue;
      if (typeof value === "string") fields[key] = value.slice(0, 256);
      else if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null) fields[key] = value;
      else if (key === "registeredProviders" && Array.isArray(value)) fields[key] = value.filter((item) => typeof item === "string").slice(0, 64).map((item) => item.slice(0, 128));
    }
    if (event === "filter.result" && fields.probe === true) this.probeCalls++;
    if (event === "filter.result" && fields.probe !== true) {
      this.filters.calls++;
      const outcome = String(fields.outcome ?? "unknown");
      this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
      if (fields.attempted !== true) this.filters.skipped++;
      else {
        this.filters.attempted++;
        if (outcome === "llm_failed_safe_cutoff") this.filters.failed++;
        else {
          this.filters.succeeded++;
          if (typeof fields.durationMs === "number") {
            if (this.successfulLatencies.length === 2048) this.successfulLatencies.shift();
            this.successfulLatencies.push(fields.durationMs);
          }
        }
      }
    }
    if (typeof fields.errorCode === "string") this.errors[fields.errorCode] = (this.errors[fields.errorCode] ?? 0) + 1;
    if (typeof fields.callId === "string") {
      if (event === "llm.started") this.pendingLlm.add(fields.callId);
      if (event === "llm.succeeded" || event === "llm.failed") this.pendingLlm.delete(fields.callId);
    }
    const key = `${fields.sessionId}:${fields.turn}`;
    if (event === "capture.queued") {
      this.captures.queued++;
      this.pending.set(key, { sessionId: fields.sessionId, turn: fields.turn });
    } else if (event === "capture.committed" || event === "capture.failed") {
      this.captures[event === "capture.committed" ? "committed" : "failed"]++;
      this.pending.delete(key);
    }
    if (typeof fields.viewerAvailable === "boolean") this.viewerAvailable = fields.viewerAvailable;
    const safe = this.redactor.redact({ ts: Date.now(), level: "info", kind: "app", channel: "dsh.diagnostics", msg: event, data: fields });
    const line = JSON.stringify({ formatVersion: 1, runId: this.runId, pid: process.pid, seq: ++this.seq, at: safe.ts, event, ...safe.data }) + "\n";
    if (this.truncated) return;
    if (this.bytes + Buffer.byteLength(line) > 8 * 1024 * 1024 - 512) {
      this.truncated = true;
      try { appendFileSync(this.file, JSON.stringify({ formatVersion: 1, runId: this.runId, pid: process.pid, seq: this.seq, at: Date.now(), event: "diagnostics.truncated" }) + "\n", "utf8"); }
      catch { this.fileErrors++; }
      return;
    }
    try { appendFileSync(this.file, line, "utf8"); this.bytes += Buffer.byteLength(line); } catch { this.fileErrors++; }
  };

  snapshot(): Record<string, unknown> {
    return {
      enabled: true, runId: this.runId, pid: process.pid, file: this.file, fileErrors: this.fileErrors, truncated: this.truncated,
      viewerAvailable: this.viewerAvailable,
      filters: { ...this.filters, outcomes: { ...this.outcomes }, successfulLatencyMs: { samples: this.successfulLatencies.length, p50: percentile(this.successfulLatencies, 0.5), p95: percentile(this.successfulLatencies, 0.95), population: "ordinary successful completions only; timeouts are censored; at most 2048 recent samples" } },
      probeCalls: this.probeCalls, errorEvents: { ...this.errors },
      pendingLlmCount: this.pendingLlm.size,
      captures: { ...this.captures, pending: this.pending.size, unfinished: [...this.pending.values()].slice(0, 100) },
    };
  }

  close(): void {
    if (this.closed) return;
    this.record("diagnostics.closed", { pendingCount: this.pending.size, pendingLlmCount: this.pendingLlm.size });
    this.closed = true;
    process.removeListener("exit", this.onExit);
    process.removeListener("beforeExit", this.onBeforeExit);
  }
}
