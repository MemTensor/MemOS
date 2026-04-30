/**
 * Health polling signal.
 *
 * Pings `/api/v1/health` every 15s. The header uses this to light up
 * the connection dot. Also exposes raw fields (uptime, version) for
 * display.
 */

import { signal } from "@preact/signals";
import { api } from "../api/client";

export type HealthStatus = "unknown" | "ok" | "degraded" | "down";
export type BridgeHealthStatus =
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "unknown";

/**
 * Most-recent call status carried on every model slot. Populated by
 * the core's `health()` endpoint from the underlying facade
 * `stats()`. Overview compares the three timestamps below — the
 * largest one wins — to paint the card green (ok), yellow (running
 * on host fallback) or red (broken).
 */
export interface ModelCallStatus {
  /** Epoch ms of the most recent direct primary-provider success. */
  lastOkAt?: number | null;
  /**
   * Epoch ms of the most recent time the primary provider failed but
   * the host LLM bridge rescued the call. Only ever set on the LLM /
   * skillEvolver slots; the embedder has no fallback so this stays
   * `null` there.
   */
  lastFallbackAt?: number | null;
  /**
   * Latest failure record. Sticky — not cleared by a later success;
   * the timestamp comparison handles "we recovered" naturally.
   */
  lastError?: { at: number; message: string } | null;
}

export interface HealthPayload {
  ok: boolean;
  version?: string;
  uptimeMs?: number;
  agent?: string;
  paths?: Record<string, string>;
  llm?: ({ available: boolean; provider: string; model: string }) & ModelCallStatus;
  embedder?:
    | ({ available: boolean; provider: string; model: string; dim: number } & ModelCallStatus);
  /**
   * `available` is `true` when the slot has a usable upstream — either a
   * concrete `provider+model+apiKey` of its own (`inherited=false`) or it
   * inherits from `llm.*` and that slot is itself available
   * (`inherited=true`). The viewer's setup banner uses this flag.
   */
  skillEvolver?:
    | ({
        available: boolean;
        provider: string;
        model: string;
        inherited: boolean;
      } & ModelCallStatus);
  bridge?: {
    status: BridgeHealthStatus;
    lastOkAt?: number | null;
    lastErrorAt?: number | null;
    lastError?: string | null;
  };
}

export const health = signal<HealthPayload | null>(null);
export const healthStatus = signal<HealthStatus>("unknown");

async function tick(): Promise<void> {
  try {
    const data = await api.get<HealthPayload>("/api/v1/health");
    health.value = data;
    healthStatus.value = data.ok ? "ok" : "degraded";
  } catch {
    health.value = null;
    healthStatus.value = "down";
  }
}

let interval: number | null = null;

export function startHealthPolling(): void {
  if (interval !== null) return;
  void tick();
  interval = window.setInterval(tick, 15_000) as unknown as number;
}

export function stopHealthPolling(): void {
  if (interval === null) return;
  window.clearInterval(interval);
  interval = null;
}
