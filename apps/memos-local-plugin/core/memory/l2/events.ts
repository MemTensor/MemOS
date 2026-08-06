/**
 * `createL2EventBus` — mirror of `core/session/events.ts` for the L2 pipeline.
 * One bus per orchestrator; subscribers get typed delivery + wildcard channel.
 */

import { rootLogger } from "../../logger/index.js";
import type { L2Event, L2EventBus, L2EventKind, L2EventListener } from "./types.js";

export function createL2EventBus(): L2EventBus {
  const byKind = new Map<L2EventKind, Set<L2EventListener>>();
  const anyListeners = new Set<L2EventListener>();
  const log = rootLogger.child({ channel: "core.memory.l2.events" });

  function add(set: Set<L2EventListener>, fn: L2EventListener): () => void {
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  function dispatch(fn: L2EventListener, evt: L2Event): void {
    try {
      fn(evt);
    } catch (err) {
      log.warn("listener_threw", {
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
