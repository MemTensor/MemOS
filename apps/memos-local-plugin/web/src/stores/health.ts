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

export interface HealthPayload {
  ok: boolean;
  version?: string;
  uptimeMs?: number;
  agent?: string;
  paths?: Record<string, string>;
  llm?: { available: boolean; provider: string; model: string };
  embedder?: { available: boolean; provider: string; model: string; dim: number };
  skillEvolver?: { provider: string; model: string; inherited: boolean };
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
