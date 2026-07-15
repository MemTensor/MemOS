/**
 * Bounded in-memory ring buffer.
 *
 * Powers `/api/logs/tail?live=false` and the in-process self-check. Holds the
 * last `capacity` records (default 1024) per category.
 */

import type { LogKind, LogLevel, LogRecord, Transport } from "../types.js";

export interface MemoryBufferOptions {
  capacity?: number;
}

export class MemoryBufferTransport implements Transport {
  readonly name = "memory-buffer";
  private readonly capacity: number;
  private readonly records: LogRecord[] = [];

  constructor(opts: MemoryBufferOptions = {}) {
    this.capacity = Math.max(64, opts.capacity ?? 1024);
  }

  accepts(_record: LogRecord): boolean {
    return true;
  }

  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
  }

  /** Snapshot the buffer (most recent first). */
  tail(filter?: { level?: LogLevel; channel?: string; kind?: LogKind; limit?: number }): LogRecord[] {
    const limit = Math.max(1, filter?.limit ?? 200);
    let acc: LogRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && acc.length < limit; i--) {
      const r = this.records[i]!;
      if (filter?.level && r.level !== filter.level) continue;
      if (filter?.kind && r.kind !== filter.kind) continue;
      if (filter?.channel && !(r.channel === filter.channel || r.channel.startsWith(filter.channel + "."))) continue;
      acc.push(r);
    }
    return acc;
  }

  size(): number {
    return this.records.length;
  }
}
