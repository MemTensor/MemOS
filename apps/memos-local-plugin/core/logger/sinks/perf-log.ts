/**
 * Perf sink → logs/perf.jsonl. Records emitted by `logger.timer(...)` end up
 * here regardless of channel level (they're a separate firehose).
 *
 * Sampling: applied at the timer call site so this sink itself just writes.
 */

import type { LogRecord, Sink, Transport } from "../types.js";

export class PerfLogSink implements Sink {
  readonly name = "perf";
  constructor(private readonly transports: Transport[]) {}

  accepts(record: LogRecord): boolean {
    return record.kind === "perf";
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
