/**
 * Console transport. Writes pretty (TTY) or JSON/compact (non-TTY) to
 * stdout/stderr. Channel filtering is handled at the sink layer.
 */

import type { LogRecord, Transport } from "../types.js";
import { formatPretty } from "../format/pretty.js";
import { formatJson } from "../format/json.js";
import { formatCompact } from "../format/compact.js";

export interface ConsoleTransportOptions {
  pretty: boolean;
  /** When `pretty` is false, choose JSON or compact for non-TTY. */
  format?: "json" | "compact";
  /** Override TTY detection (tests). */
  isTty?: boolean;
}

export class ConsoleTransport implements Transport {
  readonly name = "console";
  private readonly pretty: boolean;
  private readonly format: "json" | "compact";
  private readonly isTty: boolean;
  private readonly color: boolean;

  constructor(opts: ConsoleTransportOptions) {
    this.pretty = opts.pretty;
    this.format = opts.format ?? "json";
    this.isTty = opts.isTty ?? !!process.stdout.isTTY;
    this.color = this.pretty && this.isTty;
  }

  accepts(_record: LogRecord): boolean {
    return true;
  }

  write(record: LogRecord): void {
    const stream = record.level === "error" || record.level === "fatal" || record.level === "warn"
      ? process.stderr
      : process.stdout;
    const text = this.pretty
      ? formatPretty(record, { color: this.color }) + "\n"
      : (this.format === "compact" ? formatCompact(record) : formatJson(record));
    try {
      stream.write(text);
    } catch {
      // Never throw from a logger.
    }
  }

  flush(): void {/* console flushes on its own */}
  close(): void {/* nothing to do */}
}
