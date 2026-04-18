/**
 * Telemetry module — anonymous usage analytics via Aliyun ARMS RUM.
 *
 * Privacy-first design:
 * - Enabled by default with anonymous data only; opt-out via TELEMETRY_ENABLED=false
 * - Uses a random anonymous ID persisted locally (no PII)
 * - Never sends memory content, queries, or any user data
 * - Only sends aggregate counts, tool names, latencies, and version info
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import type { Logger } from "./types";

export interface TelemetryConfig {
  enabled?: boolean;
}

function loadTelemetryCredentials(pluginDir?: string): { endpoint: string; pid: string; env: string } {
  if (process.env.MEMOS_ARMS_ENDPOINT) {
    return {
      endpoint: process.env.MEMOS_ARMS_ENDPOINT,
      pid: process.env.MEMOS_ARMS_PID ?? "",
      env: process.env.MEMOS_ARMS_ENV ?? "prod",
    };
  }
  const bases = pluginDir ? [pluginDir, path.join(pluginDir, "src")] : [];
  if (typeof __dirname === "string") bases.push(path.resolve(__dirname, ".."), __dirname);
  const candidates = bases.map(b => path.join(b, "telemetry.credentials.json"));
  for (const credPath of candidates) {
    try {
      const raw = fs.readFileSync(credPath, "utf-8");
      const creds = JSON.parse(raw);
      if (creds.endpoint) return { endpoint: creds.endpoint, pid: creds.pid ?? "", env: creds.env ?? "prod" };
    } catch {}
  }
  return { endpoint: "", pid: "", env: "prod" };
}

const FLUSH_AT = 10;
const FLUSH_INTERVAL_MS = 30_000;
const SEND_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000; // 30 min inactivity → new session
interface ArmsEvent {
  event_type: "custom";
  type: string;
  name: string;
  group: string;
  value: number;
  properties: Record<string, string | number | boolean>;
  timestamp: number;
  event_id: string;
  times: number;
}

export class Telemetry {
  private distinctId: string;
  private enabled: boolean;
  private pluginVersion: string;
  private log: Logger;
  private dailyPingSent = false;
  private dailyPingDate = "";
  private buffer: ArmsEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string;
  private firstSeenDate: string;
  private armsEndpoint: string;
  private armsPid: string;
  private armsEnv: string;

  constructor(config: TelemetryConfig, stateDir: string, pluginVersion: string, log: Logger, pluginDir?: string) {
    this.log = log;
    this.pluginVersion = pluginVersion;
    this.enabled = config.enabled !== false;
    this.distinctId = this.loadOrCreateAnonymousId(stateDir);
    this.firstSeenDate = this.loadOrCreateFirstSeen(stateDir);
    this.sessionId = this.loadOrCreateSessionId(stateDir);

    const creds = loadTelemetryCredentials(pluginDir);
    this.armsEndpoint = creds.endpoint;
    this.armsPid = creds.pid;
    this.armsEnv = creds.env;

    if (!this.enabled || !this.armsEndpoint) {
      this.enabled = false;
      this.log.debug(
        !this.armsEndpoint
          ? "Telemetry disabled (no credentials configured)"
          : "Telemetry disabled (opt-out)",
      );
      return;
    }

    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
    this.log.debug("Telemetry initialized (ARMS)");
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

  private loadOrCreateSessionId(stateDir: string): string {
    const filePath = path.join(stateDir, "memos-local", ".session");
    try {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      const sep = raw.indexOf("|");
      if (sep > 0) {
        const ts = parseInt(raw.slice(0, sep), 10);
        const id = raw.slice(sep + 1);
        if (id.length > 10 && Date.now() - ts < SESSION_TTL_MS) {
          this.touchSession(filePath, id);
          return id;
        }
      }
    } catch {}
    const newId = uuidv4();
    this.touchSession(filePath, newId);
    return newId;
  }

  private touchSession(filePath: string, id: string): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${Date.now()}|${id}`, "utf-8");
    } catch {}
  }

  private loadOrCreateFirstSeen(stateDir: string): string {
    const filePath = path.join(stateDir, "memos-local", ".first-seen");
    try {
      const existing = fs.readFileSync(filePath, "utf-8").trim();
      if (existing.length === 10) return existing;
    } catch {}
    const today = new Date().toISOString().slice(0, 10);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, today, "utf-8");
    } catch {}
    return today;
  }

  private capture(event: string, properties?: Record<string, unknown>): void {
    if (!this.enabled) return;

    const safeProps: Record<string, string | number | boolean> = {
      plugin_version: this.pluginVersion,
      os: os.platform(),
      os_version: os.release(),
      node_version: process.version,
      arch: os.arch(),
    };
    if (properties) {
      for (const [k, v] of Object.entries(properties)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          safeProps[k] = v;
        }
      }
    }

    this.buffer.push({
      event_type: "custom",
      type: "memos_plugin",
      name: event,
      group: "memos_local",
      value: 1,
      properties: safeProps,
      timestamp: Date.now(),
      event_id: uuidv4(),
      times: 1,
    });

    if (this.buffer.length >= FLUSH_AT) {
      this.flush();
    }
  }

  private buildPayload(events: ArmsEvent[]): Record<string, unknown> {
    return {
      app: {
        id: this.armsPid,
        env: this.armsEnv,
        version: this.pluginVersion,
        type: "node",
      },
      user: { id: this.distinctId },
      session: { id: this.sessionId },
      net: {},
      view: { id: "plugin", name: "memos-local-openclaw" },
      events,
      _v: "1.0.0",
    };
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const payload = this.buildPayload(batch);

    try {
      const resp = await fetch(this.armsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      this.log.debug(`Telemetry flush: ${batch.length} events → ${resp.status}`);
    } catch (err) {
      this.log.debug(`Telemetry flush failed: ${err}`);
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

  trackSkillEvolved(skillName: string, upgradeType: "created" | "upgraded"): void {
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

  trackError(source: string, errorType: string): void {
    this.capture("plugin_error", {
      error_source: source,
      error_type: errorType,
    });
  }

  private maybeSendDailyPing(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyPingSent && this.dailyPingDate === today) return;
    this.dailyPingSent = true;
    this.dailyPingDate = today;
    this.capture("daily_active", {
      first_seen_date: this.firstSeenDate,
    });
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
