/**
 * Error-only sink → logs/error.log. Captures every WARN/ERROR/FATAL across
 * every channel so triage is one file away.
 */

import type { LogRecord, Sink, Transport } from "../types.js";
import { LOG_LEVEL_ORDER } from "../levels.js";

export class ErrorLogSink implements Sink {
  readonly name = "error";
  constructor(private readonly transports: Transport[]) {}

  accepts(record: LogRecord): boolean {
    return LOG_LEVEL_ORDER[record.level] >= LOG_LEVEL_ORDER.warn;
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
