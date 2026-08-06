/**
 * Audit sink → logs/audit.log.
 *
 * Permanent retention: monthly gzip rotation, never delete. The transport
 * passed in here MUST be configured with `keepForever: true`
 * (`mode: "audit"`).
 */

import type { LogRecord, Sink, Transport } from "../types.js";

export class AuditLogSink implements Sink {
  readonly name = "audit";
  constructor(private readonly transports: Transport[]) {}

  accepts(record: LogRecord): boolean {
    return record.kind === "audit";
  }

  write(record: LogRecord): void {
    for (const t of this.transports) {
      if (t.accepts(record)) t.write(record);
    }
  }

  async flush(): Promise<void> {
    for (const t of this.transports) await t.flush?.();
  }
  async close(): Promise<void> {
    for (const t of this.transports) await t.close?.();
  }
}
