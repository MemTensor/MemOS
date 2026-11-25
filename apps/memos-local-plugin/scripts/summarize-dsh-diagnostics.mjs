#!/usr/bin/env node
/** Metadata-only JSONL summary. No dependencies, model calls or database reads. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("Usage: node summarize-dsh-diagnostics.mjs <jsonl-file-or-directory> [...]");
  process.exit(1);
}
const files = new Set();
for (const input of inputs) {
  const path = resolve(input);
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).filter((name) => name.endsWith(".jsonl")).sort()) files.add(resolve(path, name));
  } else files.add(path);
}
const runs = new Map();
let parseErrors = 0;
for (const file of files) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { parseErrors++; continue; }
    if (typeof event.runId !== "string" || !Number.isInteger(event.seq) || typeof event.event !== "string") { parseErrors++; continue; }
    if (!runs.has(event.runId)) runs.set(event.runId, new Map());
    runs.get(event.runId).set(event.seq, event);
  }
}
function filterSummary(events) {
  const attempted = events.filter((event) => event.attempted === true);
  const success = attempted.filter((event) => event.outcome !== "llm_failed_safe_cutoff");
  const latencies = success.map((event) => event.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (p) => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
  const outcomes = {};
  for (const event of events) outcomes[event.outcome ?? "unknown"] = (outcomes[event.outcome ?? "unknown"] ?? 0) + 1;
  return { calls: events.length, attempted: attempted.length, succeeded: success.length, failed: attempted.length - success.length,
    skipped: events.length - attempted.length, outcomes,
    successfulLatencyMs: { samples: latencies.length, p50: percentile(0.5), p95: percentile(0.95), population: "successful completions only; timeouts are censored" } };
}
const summaries = [];
for (const [runId, rows] of runs) {
  const events = [...rows.values()].sort((a, b) => a.seq - b.seq);
  const pending = new Map();
  const pendingLlm = new Map();
  const errors = {};
  for (const event of events) {
    const key = JSON.stringify([event.sessionId, event.turn]);
    if (event.event === "capture.queued") pending.set(key, { sessionId: event.sessionId, turn: event.turn });
    if (["capture.committed", "capture.failed"].includes(event.event)) pending.delete(key);
    if (event.event === "llm.started") pendingLlm.set(event.callId, { callId: event.callId, provider: event.provider, model: event.model, op: event.op, sessionId: event.sessionId });
    if (["llm.succeeded", "llm.failed"].includes(event.event)) pendingLlm.delete(event.callId);
    if (event.errorCode) errors[event.errorCode] = (errors[event.errorCode] ?? 0) + 1;
  }
  const has = (name) => events.some((event) => event.event === name);
  const count = (name) => events.filter((event) => event.event === name).length;
  const filters = events.filter((event) => event.event === "filter.result");
  const probes = filters.filter((event) => event.probe === true);
  const probeGroups = {};
  for (const event of probes) {
    const key = `${event.candidateCount} candidates / ${event.timeoutMs}ms`;
    (probeGroups[key] ??= []).push(event);
  }
  summaries.push({ runId, pid: events[0]?.pid, events: events.length,
    sequenceGaps: events.length ? events.at(-1).seq - events[0].seq + 1 - events.length + Math.max(0, events[0].seq - 1) : 0,
    closed: has("diagnostics.closed"), truncated: has("diagnostics.truncated"),
    disposeStarted: has("dispose.started"), disposeFinished: has("dispose.finished"),
    lastEvent: events.at(-1), errorEvents: errors,
    pendingHostCalls: [...pendingLlm.values()],
    turns: { started: count("turn.started"), ended: count("turn.ended") },
    filters: filterSummary(filters.filter((event) => event.probe !== true)), probes: filterSummary(probes),
    probeGroups: Object.fromEntries(Object.entries(probeGroups).map(([key, group]) => [key, filterSummary(group)])),
    captures: { queued: count("capture.queued"), committed: count("capture.committed"), failed: count("capture.failed"), skipped: count("capture.skipped"), pending: [...pending.values()] },
  });
}
console.log(JSON.stringify({ files: [...files], parseErrors, runs: summaries,
  note: "An unclosed run may still be running, have been terminated, or have incomplete files. Error event counts can include multiple stages for one call. Probe latency measures synthetic filtering only, not end-to-end recall or relevance quality." }, null, 2));
