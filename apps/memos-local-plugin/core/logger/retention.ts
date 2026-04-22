/**
 * Retention helpers.
 *
 * Most retention is enforced inside `FileRotatingTransport` (size+date+gzip,
 * `maxFiles`). This file is the place to express RETENTION POLICIES (per
 * sink) so we have a single sheet of glass to audit.
 */

import type { ResolvedConfig } from "../config/schema.js";

export interface RetentionPolicy {
  /** sink name */
  sink: string;
  /** human description (for `docs/LOGGING.md`). */
  description: string;
  /** rotation by size (MB) — 0 means date-only. */
  maxSizeMb: number;
  /** number of archives to keep — 0 means forever. */
  maxFiles: number;
  /** gzip on rotation. */
  gzip: boolean;
}

export function policiesFor(cfg: ResolvedConfig): RetentionPolicy[] {
  const f = cfg.logging.file;
  return [
    {
      sink: "app",
      description: "Main human log: rotates by size+day, gzipped, keeps a window.",
      maxSizeMb: f.rotate.maxSizeMb,
      maxFiles: f.retentionDays,
      gzip: f.rotate.gzip,
    },
    {
      sink: "error",
      description: "Errors only: rotated like app, retained the same window.",
      maxSizeMb: f.rotate.maxSizeMb,
      maxFiles: f.retentionDays,
      gzip: f.rotate.gzip,
    },
    {
      sink: "audit",
      description: "Audit trail: rotated monthly, gzipped, NEVER deleted.",
      maxSizeMb: 0,
      maxFiles: 0,           // forever
      gzip: cfg.logging.audit.rotate.gzip,
    },
    {
      sink: "llm",
      description: "Per-LLM-call records: rotated daily, gzipped, kept forever (cheap).",
      maxSizeMb: 0,
      maxFiles: 0,
      gzip: f.rotate.gzip,
    },
    {
      sink: "perf",
      description: "Perf samples: rotated daily, gzipped, kept forever.",
      maxSizeMb: 0,
      maxFiles: 0,
      gzip: f.rotate.gzip,
    },
    {
      sink: "events",
      description: "Algorithm events firehose: rotated daily, gzipped, kept forever.",
      maxSizeMb: 0,
      maxFiles: 0,
      gzip: f.rotate.gzip,
    },
  ];
}
