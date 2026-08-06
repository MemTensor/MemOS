/**
 * Silent transport. Used by tests so `rootLogger` still has at least one
 * transport while not polluting test output.
 */

import type { LogRecord, Transport } from "../types.js";

export class NullTransport implements Transport {
  readonly name = "null";
  accepts(_r: LogRecord): boolean {
    return true;
  }
  write(_r: LogRecord): void {/* drop */}
}
