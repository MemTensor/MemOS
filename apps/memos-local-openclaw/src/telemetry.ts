/**
 * Telemetry module — anonymous usage analytics via PostHog.
 *
 * Privacy-first design:
 * - Enabled by default with anonymous data only; opt-out via TELEMETRY_ENABLED=false
 * - Uses a random anonymous ID persisted locally (no PII)
 * - Never sends memory content, queries, or any user data
 * - Only sends aggregate counts, tool names, latencies, and version info
 */

import { PostHog } from "posthog-node";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import type { Logger } from "./types";

export interface TelemetryConfig {
  enabled?: boolean;
  posthogApiKey?: string;
  posthogHost?: string;
}

const DEFAULT_POSTHOG_API_KEY = "phc_7lae6UC5jyImDefX6uub7zCxWyswCGNoBifCKqjvDrI";
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

export class Telemetry {
  private client: PostHog | null = null;
  private distinctId: string;
  private enabled: boolean;
  private pluginVersion: string;
  private log: Logger;
  private dailyPingSent = false;
  private dailyPingDate = "";

  constructor(config: TelemetryConfig, stateDir: string, pluginVersion: string, log: Logger) {
    this.log = log;
    this.pluginVersion = pluginVersion;
    this.enabled = config.enabled !== false;
    this.distinctId = this.loadOrCreateAnonymousId(stateDir);

    if (!this.enabled) {
      this.log.debug("Telemetry disabled (opt-out via TELEMETRY_ENABLED=false)");
      return;
    }

    const apiKey = config.posthogApiKey || DEFAULT_POSTHOG_API_KEY;
    try {
      this.client = new PostHog(apiKey, {
        host: config.posthogHost || DEFAULT_POSTHOG_HOST,
        flushAt: 10,
        flushInterval: 30_000,
      });
      this.log.debug("Telemetry initialized (PostHog)");
    } catch (err) {
      this.log.warn(`Telemetry init failed: ${err}`);
      this.enabled = false;
    }
  }

  private loadOrCreateAnonymousId(stateDir: string): string {
    const newDir = path.join(stateDir, "memos-local");
    const oldDir = path.join(stateDir, "memos-lite");
    const idFile = path.join(newDir, ".anonymous-id");
    const oldIdFile = path.join(oldDir, ".anonymous-id");

    try {
      const existing = fs.readFileSync(idFile, "utf-8").trim();
      if (existing.length > 10) return existing;
    } catch {}
    try {
      const existing = fs.readFileSync(oldIdFile, "utf-8").trim();
      if (existing.length > 10) return existing;
    } catch {}

    const newId = uuidv4();
    try {
      fs.mkdirSync(path.dirname(idFile), { recursive: true });
      fs.writeFileSync(idFile, newId, "utf-8");
    } catch {}
    return newId;
  }

  private capture(event: string, properties?: Record<string, unknown>): void {
    if (!this.enabled || !this.client) return;

    try {
      this.client.capture({
        distinctId: this.distinctId,
        event,
        properties: {
          plugin_version: this.pluginVersion,
          os: os.platform(),
          os_version: os.release(),
          node_version: process.version,
          arch: os.arch(),
          ...properties,
        },
      });
    } catch {
      // best-effort, never throw
    }
  }

  // ─── Public event methods ───

  trackPluginStarted(embeddingProvider: string, summarizerProvider: string): void {
    this.capture("plugin_started", {
      embedding_provider: embeddingProvider,
      summarizer_provider: summarizerProvider,
    });
    this.maybeSendDailyPing();
  }

  trackToolCalled(toolName: string, latencyMs: number, success: boolean): void {
    this.capture(toolName, {
      latency_ms: Math.round(latencyMs),
      success,
    });
  }

  trackMemoryIngested(chunkCount: number): void {
    this.capture("memory_ingested", {
      chunk_count: chunkCount,
    });
  }

  trackSkillInstalled(skillName: string): void {
    this.capture("skill_installed", {
      skill_name: skillName,
    });
  }

  trackSkillEvolved(skillName: string, upgradeType: string): void {
    this.capture("skill_evolved", {
      skill_name: skillName,
      upgrade_type: upgradeType,
    });
  }

  trackViewerOpened(): void {
    this.capture("viewer_opened");
  }

  trackAutoRecall(hitCount: number, latencyMs: number): void {
    this.capture("memory_search", {
      auto: true,
      hit_count: hitCount,
      latency_ms: Math.round(latencyMs),
    });
  }

  private maybeSendDailyPing(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyPingSent && this.dailyPingDate === today) return;
    this.dailyPingSent = true;
    this.dailyPingDate = today;
    this.capture("daily_active");
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.shutdown();
      } catch {}
    }
  }
}
