/**
 * High-resolution operation timer used by `logger.timer(...)`.
 *
 * The returned `PerfSpan`:
 *   - implements `Symbol.dispose` (so `using span = log.timer("op")` works);
 *   - emits a `kind: "perf"` record on close;
 *   - is idempotent — calling `end()` twice or disposing after `end()` is a
 *     no-op.
 */

import { hrNowMs } from "../time.js";
import type { PerfSpan } from "./types.js";

export interface TimerEnvelope {
  channel: string;
  op: string;
  /** Initial extra context. */
  extra?: Record<string, unknown>;
  /** Sampling rate in [0, 1]; emit is skipped probabilistically when < 1. */
  sampleRate: number;
  /** Called when the span closes (with the constructed perf record fields). */
  emit(payload: { ms: number; channel: string; op: string; extra: Record<string, unknown> }): void;
}

export function createSpan(env: TimerEnvelope): PerfSpan {
  const start = hrNowMs();
  let closed = false;
  const close = (more?: Record<string, unknown>) => {
    if (closed) return;
    closed = true;
    if (env.sampleRate < 1 && Math.random() > env.sampleRate) return;
    const ms = hrNowMs() - start;
    env.emit({ ms, channel: env.channel, op: env.op, extra: { ...(env.extra ?? {}), ...(more ?? {}) } });
  };
  return {
    end(extra?: Record<string, unknown>) { close(extra); },
    [Symbol.dispose]() { close(); },
  };
}
