/**
 * In-process broadcast transport.
 *
 * Holds a Node EventEmitter that `server/sse.ts` subscribes to. Listeners
 * receive every (post-redaction) record. The broadcaster is global so any
 * sink can push, and the server can subscribe once.
 */

import { EventEmitter } from "node:events";

import type { LogRecord, Transport } from "../types.js";

export type LogListener = (record: LogRecord) => void;

const bus = new EventEmitter();
bus.setMaxListeners(64);

export const LOG_BROADCAST_EVENT = "log";

export function onBroadcastLog(listener: LogListener): () => void {
  bus.on(LOG_BROADCAST_EVENT, listener);
  return () => bus.off(LOG_BROADCAST_EVENT, listener);
}

export function broadcastLog(record: LogRecord): void {
  bus.emit(LOG_BROADCAST_EVENT, record);
}

export class SseBroadcastTransport implements Transport {
  readonly name = "sse-broadcast";

  accepts(_record: LogRecord): boolean {
    return true;
  }

  write(record: LogRecord): void {
    try {
      bus.emit(LOG_BROADCAST_EVENT, record);
    } catch {
      // never throw
    }
  }
}
