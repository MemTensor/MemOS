import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000;

interface QueueRow {
  id: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  claimed_by: string | null;
  lease_until: number | null;
  last_error: string | null;
  source_text: string;
}

function row(handle: TmpDbHandle, id: string): QueueRow {
  return handle.db.prepare<{ id: string }, QueueRow>(
    `SELECT id, status, attempts, next_attempt_at, claimed_by, lease_until, last_error, source_text
       FROM embedding_retry_queue
      WHERE id=@id`,
  ).get({ id })!;
}

describe("embedding retry queue", () => {
  let handle: TmpDbHandle;

  beforeEach(() => {
    handle = makeTmpDb({ agent: "openclaw" });
  });

  afterEach(() => handle.cleanup());

  it("does not claim jobs before next_attempt_at", () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_future",
      targetKind: "trace",
      targetId: "tr_1",
      vectorField: "vec_summary",
      sourceText: "future",
      now: NOW + 60_000,
    });

    expect(handle.repos.embeddingRetryQueue.claimDue({
      now: NOW,
      workerId: "worker-a",
      leaseUntil: NOW + 300_000,
    })).toEqual([]);
    expect(row(handle, "er_future")).toMatchObject({
      status: "pending",
      claimed_by: null,
      lease_until: null,
    });
  });

  it("leases a due job once and allows another worker only after lease expiry", () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_due",
      targetKind: "trace",
      targetId: "tr_1",
      vectorField: "vec_summary",
      sourceText: "due",
      now: NOW,
    });

    const first = handle.repos.embeddingRetryQueue.claimDue({
      now: NOW,
      workerId: "worker-a",
      leaseUntil: NOW + 300_000,
    });
    expect(first.map((j) => j.id)).toEqual(["er_due"]);
    expect(row(handle, "er_due")).toMatchObject({
      status: "in_progress",
      claimed_by: "worker-a",
      lease_until: NOW + 300_000,
    });

    expect(handle.repos.embeddingRetryQueue.claimDue({
      now: NOW + 10_000,
      workerId: "worker-b",
      leaseUntil: NOW + 310_000,
    })).toEqual([]);

    const stolen = handle.repos.embeddingRetryQueue.claimDue({
      now: NOW + 300_000,
      workerId: "worker-b",
      leaseUntil: NOW + 600_000,
    });
    expect(stolen.map((j) => j.id)).toEqual(["er_due"]);
    expect(row(handle, "er_due")).toMatchObject({
      status: "in_progress",
      claimed_by: "worker-b",
      lease_until: NOW + 600_000,
    });
  });

  it("rejects stale completion from a worker whose lease was stolen", () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_stale",
      targetKind: "trace",
      targetId: "tr_1",
      vectorField: "vec_summary",
      sourceText: "due",
      now: NOW,
    });
    const first = handle.repos.embeddingRetryQueue.claimDue({
      now: NOW,
      workerId: "worker-a",
      leaseUntil: NOW + 300_000,
    })[0]!;
    const stolen = handle.repos.embeddingRetryQueue.claimDue({
      now: NOW + 300_000,
      workerId: "worker-b",
      leaseUntil: NOW + 600_000,
    })[0]!;

    expect(handle.repos.embeddingRetryQueue.markSucceededClaimed(first.id, {
      workerId: first.claimedBy!,
      leaseUntil: first.leaseUntil!,
      now: NOW + 300_001,
    })).toBe(false);
    expect(handle.repos.embeddingRetryQueue.markRetryClaimed(first.id, {
      workerId: first.claimedBy!,
      leaseUntil: first.leaseUntil!,
      attempts: 1,
      nextAttemptAt: NOW + 360_000,
      error: "stale failure",
      now: NOW + 300_001,
    })).toBe(false);
    expect(row(handle, "er_stale")).toMatchObject({
      status: "in_progress",
      claimed_by: "worker-b",
      lease_until: NOW + 600_000,
      attempts: 0,
      last_error: null,
    });

    expect(handle.repos.embeddingRetryQueue.markSucceededClaimed(stolen.id, {
      workerId: stolen.claimedBy!,
      leaseUntil: stolen.leaseUntil!,
      now: NOW + 300_002,
    })).toBe(true);
    expect(row(handle, "er_stale")).toMatchObject({
      status: "succeeded",
      claimed_by: null,
      lease_until: null,
    });
  });

  it("reenqueue resets terminal jobs and clears stale lease/error state", () => {
    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_reset",
      targetKind: "trace",
      targetId: "tr_1",
      vectorField: "vec_summary",
      sourceText: "old",
      now: NOW,
    });
    handle.repos.embeddingRetryQueue.claimDue({
      now: NOW,
      workerId: "worker-a",
      leaseUntil: NOW + 300_000,
    });
    handle.repos.embeddingRetryQueue.markFailed("er_reset", {
      attempts: 6,
      error: "embedder down",
      now: NOW + 1,
    });

    handle.repos.embeddingRetryQueue.enqueue({
      id: "er_reset_2",
      targetKind: "trace",
      targetId: "tr_1",
      vectorField: "vec_summary",
      sourceText: "new",
      now: NOW + 2,
    });

    expect(row(handle, "er_reset")).toMatchObject({
      status: "pending",
      attempts: 0,
      claimed_by: null,
      lease_until: null,
      last_error: null,
      source_text: "new",
    });
  });
});
