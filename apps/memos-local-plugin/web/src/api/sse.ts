/**
 * SSE client with reconnect + last-event-id.
 *
 * `EventSource` doesn't support custom headers, so when an API key is
 * required we fall back to `fetch` + ReadableStream manually. The
 * caller registers handlers per event-name and the stream reconnects
 * automatically with exponential backoff on errors.
 */

export type SseHandler = (event: string, data: string, id?: string) => void;

export interface SseHandle {
  close(): void;
  get lastEventId(): string | undefined;
}

interface SseOptions {
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  initialReconnectMs?: number;
  maxReconnectMs?: number;
  /** If set, `x-api-key` is sent and the fallback fetch path is used. */
  apiKey?: string | null;
}

import { withAgentPrefix } from "./client.js";

export function openSse(
  rawPath: string,
  handler: SseHandler,
  opts: SseOptions = {},
): SseHandle {
  const path = withAgentPrefix(rawPath);
  const apiKey = opts.apiKey ?? localStorage.getItem("memos.apiKey");
  let closed = false;
  let lastEventId: string | undefined;
  let backoffMs = opts.initialReconnectMs ?? 500;
  const maxBackoff = opts.maxReconnectMs ?? 16_000;
  let controller: AbortController | null = null;

  function onOpen() {
    backoffMs = opts.initialReconnectMs ?? 500;
    opts.onOpen?.();
  }

  function emit(event: string, data: string, id?: string) {
    if (id) lastEventId = id;
    handler(event, data, id);
  }

  async function runFetch(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    try {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (apiKey) headers["x-api-key"] = apiKey;
      if (lastEventId) headers["last-event-id"] = lastEventId;
      const res = await fetch(path, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status}`);
      }
      onOpen();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let curEvent = "message";
      let curData: string[] = [];
      let curId: string | undefined;
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        while (buf.includes("\n")) {
          const idx = buf.indexOf("\n");
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line === "") {
            if (curData.length) {
              emit(curEvent, curData.join("\n"), curId);
            }
            curEvent = "message";
            curData = [];
            curId = undefined;
            continue;
          }
          if (line.startsWith(":")) continue; // comment/keepalive
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const field = line.slice(0, colon);
          let val = line.slice(colon + 1);
          if (val.startsWith(" ")) val = val.slice(1);
          if (field === "event") curEvent = val;
          else if (field === "data") curData.push(val);
          else if (field === "id") curId = val;
        }
      }
    } catch (err) {
      if (!closed) opts.onError?.(err);
    }
  }

  async function loop() {
    while (!closed) {
      await runFetch();
      if (closed) break;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, maxBackoff);
    }
  }

  // Always use fetch streaming — gives uniform behavior with or without
  // API key, preserves named event types, and avoids EventSource's
  // lack of per-event listener support without explicit registration.
  void loop();

  return {
    close() {
      if (closed) return;
      closed = true;
      try { controller?.abort(); } catch { /* noop */ }
    },
    get lastEventId() { return lastEventId; },
  };
}
