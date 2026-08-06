/**
 * `createCaptureEventBus` — mirror of `core/session/events.ts` for the
 * capture pipeline. One bus per `CaptureRunner`; consumers subscribe and
 * get a typed delivery with per-kind and wildcard channels.
 */

import { rootLogger } from "../logger/index.js";
import type {
  CaptureEvent,
  CaptureEventBus,
  CaptureEventKind,
  CaptureEventListener,
} from "./types.js";

export function createCaptureEventBus(): CaptureEventBus {
  const byKind = new Map<CaptureEventKind, Set<CaptureEventListener>>();
  const anyListeners = new Set<CaptureEventListener>();
  const log = rootLogger.child({ channel: "core.capture" });

  function add(set: Set<CaptureEventListener>, fn: CaptureEventListener): () => void {
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  function dispatch(fn: CaptureEventListener, evt: CaptureEvent): void {
    try {
      fn(evt);
    } catch (err) {
      log.warn("event.listener_error", {
        kind: evt.kind,
        err: err instanceof Error ? { name: err.name, message: err.message } : { value: String(err) },
      });
    }
  }

  return {
    on(kind, fn) {
      let set = byKind.get(kind);
      if (!set) {
        set = new Set();
        byKind.set(kind, set);
      }
      return add(set, fn);
    },
    onAny(fn) {
      return add(anyListeners, fn);
    },
    emit(evt) {
      const targeted = byKind.get(evt.kind);
      if (targeted) for (const fn of targeted) dispatch(fn, evt);
      for (const fn of anyListeners) dispatch(fn, evt);
    },
    listenerCount(kind) {
      if (!kind) {
        let total = anyListeners.size;
        for (const set of byKind.values()) total += set.size;
        return total;
      }
      return (byKind.get(kind)?.size ?? 0) + anyListeners.size;
    },
  };
}
