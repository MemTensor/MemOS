/**
 * `createL3EventBus` — mirror of `core/memory/l2/events.ts` for the L3
 * pipeline. One bus per orchestrator; listeners get typed delivery +
 * wildcard channel, and any listener error is logged but does not leak.
 */

import { rootLogger } from "../../logger/index.js";
import type { L3Event, L3EventBus, L3EventKind, L3EventListener } from "./types.js";

export function createL3EventBus(): L3EventBus {
  const byKind = new Map<L3EventKind, Set<L3EventListener>>();
  const anyListeners = new Set<L3EventListener>();
  const log = rootLogger.child({ channel: "core.memory.l3.events" });

  function add(set: Set<L3EventListener>, fn: L3EventListener): () => void {
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  function dispatch(fn: L3EventListener, evt: L3Event): void {
    try {
      fn(evt);
    } catch (err) {
      log.warn("listener_threw", {
        kind: evt.kind,
        err:
          err instanceof Error
            ? { name: err.name, message: err.message }
            : { value: String(err) },
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
