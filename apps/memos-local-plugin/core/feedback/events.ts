/**
 * `createFeedbackEventBus` — dedicated bus for the Decision Repair pipeline.
 * Mirrors the shape of the L2 / L3 / skill buses so wiring is uniform.
 */

import { rootLogger } from "../logger/index.js";
import type {
  FeedbackEvent,
  FeedbackEventBus,
  FeedbackEventKind,
  FeedbackEventListener,
} from "./types.js";

export function createFeedbackEventBus(): FeedbackEventBus {
  const byKind = new Map<FeedbackEventKind, Set<FeedbackEventListener>>();
  const anyListeners = new Set<FeedbackEventListener>();
  const log = rootLogger.child({ channel: "core.feedback.events" });

  function add(
    set: Set<FeedbackEventListener>,
    fn: FeedbackEventListener,
  ): () => void {
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  function dispatch(fn: FeedbackEventListener, evt: FeedbackEvent): void {
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
