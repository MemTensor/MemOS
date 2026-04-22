/**
 * Events sink → logs/events.jsonl. Mirrors every CoreEvent the algorithm
 * emits as a `LogRecord` with `kind === "events"`.
 */

import type { LogRecord, Sink, Transport } from "../types.js";

export class EventsLogSink implements Sink {
  readonly name = "events";
  constructor(private readonly transports: Transport[]) {}

  accepts(record: LogRecord): boolean {
    return record.kind === "events";
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
