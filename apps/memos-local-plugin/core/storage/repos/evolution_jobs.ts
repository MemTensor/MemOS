import { ids } from "../../id.js";
import type { StorageDb } from "../types.js";

export type EvolutionJobStatus =
  | "queued"
  | "leased"
  | "failed"
  | "succeeded"
  | "dead_letter";

export type EvolutionJobType =
  | "turn_enrichment"
  | "episode_evolution"
  | "feedback_evolution";

export const EVOLUTION_JOB_TYPES: readonly EvolutionJobType[] = [
  "turn_enrichment",
  "episode_evolution",
  "feedback_evolution",
];

export interface EvolutionJob {
  id: string;
  jobType: EvolutionJobType;
  status: EvolutionJobStatus;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  claimedBy: string | null;
  leaseUntil: number | null;
  rerunRequested: boolean;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvolutionJobClaim {
  workerId: string;
  leaseUntil: number;
}

interface RawEvolutionJob {
  id: string;
  job_type: EvolutionJobType;
  status: EvolutionJobStatus;
  dedupe_key: string | null;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  available_at: number;
  claimed_by: string | null;
  lease_until: number | null;
  rerun_requested: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `
  id, job_type, status, dedupe_key, payload_json, attempts, max_attempts,
  available_at, claimed_by, lease_until, rerun_requested, last_error,
  created_at, updated_at
`;

export function makeEvolutionJobsRepo(
  db: StorageDb,
  onDeadLetter?: () => void,
) {
  const getById = db.prepare<{ id: string }, RawEvolutionJob>(
    `SELECT ${COLUMNS} FROM evolution_jobs WHERE id=@id`,
  );

  function get(id: string): EvolutionJob | null {
    const row = getById.get({ id });
    return row ? mapRow(row) : null;
  }

  return {
    enqueue(input: {
      jobType: EvolutionJobType;
      dedupeKey?: string;
      payload?: Record<string, unknown>;
      maxAttempts?: number;
      availableAt?: number;
      /** Return an existing succeeded/dead-letter job instead of recreating it. */
      preserveTerminal?: boolean;
      now: number;
    }): EvolutionJob {
      const write = (): EvolutionJob => {
        const existing = input.dedupeKey
          ? db.prepare<{ key: string }, RawEvolutionJob>(
              `SELECT ${COLUMNS}
                 FROM evolution_jobs
                WHERE dedupe_key=@key
                  ${input.preserveTerminal
                    ? ""
                    : "AND status IN ('queued','leased','failed')"}
                ORDER BY created_at DESC
                LIMIT 1`,
            ).get({ key: input.dedupeKey })
          : undefined;
        if (existing) {
          if (
            input.preserveTerminal &&
            (existing.status === "succeeded" ||
              existing.status === "dead_letter")
          ) {
            return mapRow(existing);
          }
          const payload = { ...parsePayload(existing.payload_json), ...(input.payload ?? {}) };
          db.prepare<{
            id: string;
            payload: string;
            available_at: number;
            max_attempts: number;
            now: number;
          }>(
            `UPDATE evolution_jobs
                SET payload_json=@payload,
                    status=CASE WHEN status='failed' THEN 'queued' ELSE status END,
                    available_at=MIN(available_at, @available_at),
                    max_attempts=MAX(max_attempts, @max_attempts),
                    rerun_requested=CASE WHEN status='leased' THEN 1 ELSE rerun_requested END,
                    last_error=CASE WHEN status='failed' THEN NULL ELSE last_error END,
                    updated_at=@now
              WHERE id=@id`,
          ).run({
            id: existing.id,
            payload: JSON.stringify(payload),
            available_at: input.availableAt ?? input.now,
            max_attempts: input.maxAttempts ?? 3,
            now: input.now,
          });
          return get(existing.id)!;
        }

        const id = `ev_${ids.span()}`;
        db.prepare<{
          id: string;
          job_type: EvolutionJobType;
          dedupe_key: string | null;
          payload: string;
          max_attempts: number;
          available_at: number;
          now: number;
        }>(
          `INSERT INTO evolution_jobs (
             id, job_type, status, dedupe_key, payload_json, attempts,
             max_attempts, available_at, claimed_by, lease_until,
             rerun_requested, last_error, created_at, updated_at
           ) VALUES (
             @id, @job_type, 'queued', @dedupe_key, @payload, 0,
             @max_attempts, @available_at, NULL, NULL, 0, NULL, @now, @now
           )`,
        ).run({
          id,
          job_type: input.jobType,
          dedupe_key: input.dedupeKey ?? null,
          payload: JSON.stringify(input.payload ?? {}),
          max_attempts: input.maxAttempts ?? 3,
          available_at: input.availableAt ?? input.now,
          now: input.now,
        });
        return get(id)!;
      };
      // Feedback persistence composes this repository inside a wider
      // transaction. Reuse that transaction instead of opening an avoidable
      // nested savepoint, so the business row and its durable job commit or
      // roll back together.
      return db.raw.inTransaction ? write() : db.tx(write);
    },

    get,

    leaseDue(input: {
      workerId: string;
      now: number;
      leaseUntil: number;
      supportedJobTypes?: readonly EvolutionJobType[];
      limit?: number;
    }): EvolutionJob[] {
      const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 1)));
      const supportedJobTypes = input.supportedJobTypes ?? EVOLUTION_JOB_TYPES;
      if (supportedJobTypes.length === 0) return [];
      const supported = supportedJobTypeClause(supportedJobTypes);
      // The in-process worker already drains one job at a time, but this
      // database-level guard is the final authority when two runtimes race
      // during startup. BEGIN IMMEDIATE serializes claimers across SQLite
      // connections/processes, and the live-lease check makes the lane global
      // to this MEMOS_HOME rather than global only to one Node process.
      const claim = db.raw.transaction(() => {
        const activeLease = db.prepare<{ now: number }, { id: string }>(
          `SELECT id FROM evolution_jobs
            WHERE status='leased' AND lease_until IS NOT NULL AND lease_until > @now
            LIMIT 1`,
        ).get({ now: input.now });
        if (activeLease) return [];

        const rows = db.prepare<Record<string, unknown>, RawEvolutionJob>(
          `SELECT ${COLUMNS}
             FROM evolution_jobs
            WHERE attempts < max_attempts
              AND job_type IN (${supported.sql})
              AND (
                (status IN ('queued','failed') AND available_at <= @now)
                OR (status='leased' AND lease_until IS NOT NULL AND lease_until <= @now)
              )
            ORDER BY available_at ASC, created_at ASC
            LIMIT @limit`,
        ).all({ now: input.now, limit, ...supported.params });
        const claimed: EvolutionJob[] = [];
        for (const row of rows) {
          db.prepare<{
            id: string;
            worker_id: string;
            lease_until: number;
            now: number;
          }>(
            `UPDATE evolution_jobs
                SET status='leased', attempts=attempts + 1,
                    claimed_by=@worker_id, lease_until=@lease_until,
                    updated_at=@now
              WHERE id=@id`,
          ).run({
            id: row.id,
            worker_id: input.workerId,
            lease_until: input.leaseUntil,
            now: input.now,
          });
          claimed.push(get(row.id)!);
        }
        return claimed;
      });
      return claim.immediate();
    },

    completeClaimed(
      id: string,
      claim: EvolutionJobClaim & { now: number },
    ): "completed" | "requeued" | "stale" {
      return db.tx(() => {
        const current = get(id);
        if (
          !current ||
          current.status !== "leased" ||
          current.claimedBy !== claim.workerId ||
          current.leaseUntil !== claim.leaseUntil
        ) {
          return "stale";
        }
        if (current.rerunRequested) {
          db.prepare<{ id: string; now: number }>(
            `UPDATE evolution_jobs
                SET status='queued', attempts=0, available_at=@now,
                    claimed_by=NULL, lease_until=NULL, rerun_requested=0,
                    last_error=NULL, updated_at=@now
              WHERE id=@id`,
          ).run({ id, now: claim.now });
          return "requeued";
        }
        db.prepare<{ id: string; now: number }>(
          `UPDATE evolution_jobs
              SET status='succeeded', claimed_by=NULL, lease_until=NULL,
                  rerun_requested=0, last_error=NULL, updated_at=@now
            WHERE id=@id`,
        ).run({ id, now: claim.now });
        return "completed";
      });
    },

    renewClaimed(
      id: string,
      claim: EvolutionJobClaim & { nextLeaseUntil: number; now: number },
    ): boolean {
      const changed = db.prepare<{
        id: string;
        worker_id: string;
        lease_until: number;
        next_lease_until: number;
        now: number;
      }>(
        `UPDATE evolution_jobs
            SET lease_until=@next_lease_until, updated_at=@now
          WHERE id=@id AND status='leased'
            AND claimed_by=@worker_id AND lease_until=@lease_until`,
      ).run({
        id,
        worker_id: claim.workerId,
        lease_until: claim.leaseUntil,
        next_lease_until: claim.nextLeaseUntil,
        now: claim.now,
      }).changes;
      return changed === 1;
    },

    failClaimed(input: {
      id: string;
      workerId: string;
      leaseUntil: number;
      error: string;
      nextAttemptAt: number;
      now: number;
    }): "failed" | "dead_letter" | "stale" {
      return db.tx(() => {
        const current = get(input.id);
        if (
          !current ||
          current.status !== "leased" ||
          current.claimedBy !== input.workerId ||
          current.leaseUntil !== input.leaseUntil
        ) {
          return "stale";
        }
        const status = current.attempts >= current.maxAttempts ? "dead_letter" : "failed";
        db.prepare<{
          id: string;
          status: "failed" | "dead_letter";
          error: string;
          available_at: number;
          now: number;
        }>(
          `UPDATE evolution_jobs
              SET status=@status, available_at=@available_at,
                  claimed_by=NULL, lease_until=NULL, last_error=@error,
                  updated_at=@now
            WHERE id=@id`,
        ).run({
          id: input.id,
          status,
          error: input.error,
          available_at: input.nextAttemptAt,
          now: input.now,
        });
        if (status === "dead_letter") onDeadLetter?.();
        return status;
      });
    },

    recoverLeases(now: number): number {
      return db.prepare<{ now: number }>(
        `UPDATE evolution_jobs
            SET status='queued', claimed_by=NULL, lease_until=NULL,
                attempts=MAX(0, attempts - 1), available_at=@now,
                updated_at=@now
          WHERE status='leased' AND (lease_until IS NULL OR lease_until <= @now)`,
      ).run({ now }).changes;
    },

    retryDeadLetter(id: string, now: number): boolean {
      return db.prepare<{ id: string; now: number }>(
        `UPDATE evolution_jobs
            SET status='queued', attempts=0, available_at=@now,
                claimed_by=NULL, lease_until=NULL, rerun_requested=0,
                last_error=NULL, updated_at=@now
          WHERE id=@id AND status='dead_letter'`,
      ).run({ id, now }).changes === 1;
    },

    nextAvailableAt(
      supportedJobTypes: readonly EvolutionJobType[] = EVOLUTION_JOB_TYPES,
    ): number | null {
      if (supportedJobTypes.length === 0) return null;
      const supported = supportedJobTypeClause(supportedJobTypes);
      return db.prepare<Record<string, unknown>, { at: number | null }>(
        `SELECT CASE
                  WHEN EXISTS (SELECT 1 FROM evolution_jobs WHERE status='leased')
                    THEN (SELECT MIN(COALESCE(lease_until, available_at))
                            FROM evolution_jobs WHERE status='leased')
                  ELSE (SELECT MIN(available_at) FROM evolution_jobs
                         WHERE status IN ('queued','failed')
                           AND attempts < max_attempts
                           AND job_type IN (${supported.sql}))
                END AS at`,
      ).get(supported.params)?.at ?? null;
    },

    countActive(): number {
      return db.prepare<unknown, { n: number }>(
        `SELECT COUNT(*) AS n FROM evolution_jobs WHERE status IN ('queued','leased','failed')`,
      ).get()?.n ?? 0;
    },

    countByStatus(status: EvolutionJobStatus): number {
      return db.prepare<{ status: EvolutionJobStatus }, { n: number }>(
        `SELECT COUNT(*) AS n FROM evolution_jobs WHERE status=@status`,
      ).get({ status })?.n ?? 0;
    },

    list(status?: EvolutionJobStatus, limit = 100): EvolutionJob[] {
      const normalizedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
      const rows = status
        ? db.prepare<{ status: EvolutionJobStatus; limit: number }, RawEvolutionJob>(
            `SELECT ${COLUMNS} FROM evolution_jobs
              WHERE status=@status ORDER BY created_at ASC LIMIT @limit`,
          ).all({ status, limit: normalizedLimit })
        : db.prepare<{ limit: number }, RawEvolutionJob>(
            `SELECT ${COLUMNS} FROM evolution_jobs ORDER BY created_at ASC LIMIT @limit`,
          ).all({ limit: normalizedLimit });
      return rows.map(mapRow);
    },
  };
}

function mapRow(row: RawEvolutionJob): EvolutionJob {
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    dedupeKey: row.dedupe_key,
    payload: parsePayload(row.payload_json),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    claimedBy: row.claimed_by,
    leaseUntil: row.lease_until,
    rerunRequested: row.rerun_requested === 1,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function supportedJobTypeClause(types: readonly EvolutionJobType[]): {
  sql: string;
  params: Record<string, EvolutionJobType>;
} {
  const unique = [...new Set(types)];
  return {
    sql: unique.map((_, index) => `@job_type_${index}`).join(", "),
    params: Object.fromEntries(
      unique.map((type, index) => [`job_type_${index}`, type]),
    ) as Record<string, EvolutionJobType>,
  };
}
