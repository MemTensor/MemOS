/**
 * LLM call sink → logs/llm.jsonl. Every record with `kind === "llm"` lands
 * here. The payload includes provider/model/op/latency/tokens/(prompt+
 * completion if not redacted).
 */

import type { LogRecord, Sink, Transport } from "../types.js";

export class LlmLogSink implements Sink {
  readonly name = "llm";
  constructor(private readonly transports: Transport[]) {}

  accepts(record: LogRecord): boolean {
    return record.kind === "llm";
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
