/**
 * App sink: routes "app" + "events" + "perf" + "audit" + "llm" + "error"
 * records that should ALSO appear in the human-readable main log to
 * `logs/memos.log`.
 *
 * That is: every record except the binary firehose ones (we let those go to
 * their own dedicated jsonl files via separate sinks).
 */

import type { LogRecord, Sink, Transport } from "../types.js";

export class AppLogSink implements Sink {
  readonly name = "app";
  constructor(private readonly transports: Transport[]) {}

  accepts(record: LogRecord): boolean {
    // Anything app-flavored or important enough to appear in memos.log
    return record.kind === "app" || record.kind === "audit" || record.kind === "error";
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
