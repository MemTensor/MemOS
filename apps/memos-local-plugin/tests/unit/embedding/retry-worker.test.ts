import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmbeddingRetryWorker } from "../../../core/embedding/retry-worker.js";
import { rootLogger } from "../../../core/logger/index.js";
import type { EpisodeId, SessionId, TraceId } from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

const NOW = 1_700_000_000_000;

interface QueueRow {
  status: string;
  attempts: number;
  next_attempt_at: number;
  claimed_by: string | null;
  lease_until: number | null;
  last_error: string | null;
}

function queueRow(handle: TmpDbHandle, id: string): QueueRow {
  return handle.db.prepare<{ id: string }, QueueRow>(
    `SELECT status, attempts, next_attempt_at, claimed_by, lease_until, last_error
       FROM embedding_retry_queue
      WHERE id=@id`,
  ).get({ id })!;
}

describe("embedding retry worker", () => {
  let handle: TmpDbHandle;

  beforeEach(() => {
    handle = makeTmpDb({ agent: "openclaw" });
    handle.repos.sessions.upsert({
      id: "s1" as SessionId,
      agent: "openclaw",
      startedAt: NOW,
      lastSeenAt: NOW,
      meta: {},
    });
    handle.repos.episodes.upsert({
      id: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      startedAt: NOW as never,
      endedAt: null,
      traceIds: [],
      rTask: null,
      status: "open",
    });
    handle.repos.traces.insert({
      id: "tr_retry" as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: "retry me",
      agentText: "ok",
      toolCalls: [],
      reflection: null,
      value: 0,
      alpha: 0,
      rHuman: null,
      priority: 0.5,
      tags: [],
      vecSummary: null,
      vecAction: null,
      turnId: NOW as never,
      schemaVersion: 1,
    });
  });

  afterEach(() => handle.cleanup());

  it("fills a queued trace vector", async () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_ok",
      targetKind: "trace",
      targetId: "tr_retry",
      vectorField: "vec_summary",
      sourceText: "retry me",
      now: NOW,
    });
    const worker = createEmbeddingRetryWorker({
      repos: handle.repos,
      embedder: fakeEmbedder({ dimensions: 8 }),
      log: rootLogger.child({ channel: "test.embedding.retry" }),
      now: () => NOW,
      intervalMs: 60_000,
    });

    await worker.flush();

    expect(handle.repos.traces.getById("tr_retry" as TraceId)?.vecSummary).not.toBeNull();
    expect(handle.repos.embeddingRetryQueue.countByStatus("succeeded")).toBe(1);
  });

  it("marks terminal failures and records a system error", async () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_fail",
      targetKind: "trace",
      targetId: "tr_retry",
      vectorField: "vec_summary",
      sourceText: "retry me",
      maxAttempts: 1,
      now: NOW,
    });
    const events: unknown[] = [];
    const worker = createEmbeddingRetryWorker({
      repos: handle.repos,
      embedder: fakeEmbedder({ throwWith: new Error("retry boom") }),
      log: rootLogger.child({ channel: "test.embedding.retry" }),
      now: () => NOW,
      onSystemError: (payload) => events.push(payload),
    });

    await worker.flush();

    expect(handle.repos.embeddingRetryQueue.countByStatus("failed")).toBe(1);
    expect(handle.repos.apiLogs.list({ toolName: "system_error", limit: 5, offset: 0 })).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("leaves queued work untouched when no embedder is configured", async () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_no_embedder",
      targetKind: "trace",
      targetId: "tr_retry",
      vectorField: "vec_summary",
      sourceText: "retry me",
      now: NOW,
    });
    const worker = createEmbeddingRetryWorker({
      repos: handle.repos,
      embedder: null,
      log: rootLogger.child({ channel: "test.embedding.retry" }),
      now: () => NOW,
    });

    await worker.flush();

    expect(queueRow(handle, "er_no_embedder")).toMatchObject({
      status: "pending",
      attempts: 0,
      claimed_by: null,
      lease_until: null,
    });
  });

  it("backs off non-terminal embedder failures and clears the lease", async () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_retry",
      targetKind: "trace",
      targetId: "tr_retry",
      vectorField: "vec_summary",
      sourceText: "retry me",
      maxAttempts: 3,
      now: NOW,
    });
    const worker = createEmbeddingRetryWorker({
      repos: handle.repos,
      embedder: fakeEmbedder({ throwWith: new Error("temporary outage") }),
      log: rootLogger.child({ channel: "test.embedding.retry" }),
      now: () => NOW,
    });

    await worker.flush();

    expect(queueRow(handle, "er_retry")).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: NOW + 60_000,
      claimed_by: null,
      lease_until: null,
      last_error: "temporary outage",
    });
    expect(handle.repos.apiLogs.list({ toolName: "system_error", limit: 5, offset: 0 })).toHaveLength(1);
  });

  it("treats missing target rows as retry failures", async () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_missing",
      targetKind: "trace",
      targetId: "tr_missing",
      vectorField: "vec_summary",
      sourceText: "orphan",
      maxAttempts: 1,
      now: NOW,
    });
    const worker = createEmbeddingRetryWorker({
      repos: handle.repos,
      embedder: fakeEmbedder({ dimensions: 8 }),
      log: rootLogger.child({ channel: "test.embedding.retry" }),
      now: () => NOW,
    });

    await worker.flush();

    expect(queueRow(handle, "er_missing")).toMatchObject({
      status: "failed",
      attempts: 1,
      claimed_by: null,
      lease_until: null,
      last_error: "embedding retry target not found: trace:tr_missing",
    });
  });
});
