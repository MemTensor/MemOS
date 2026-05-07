/**
 * Telemetry module — anonymous usage analytics via Aliyun ARMS RUM.
 *
 * Privacy-first design:
 * - Enabled by default; opt-out via config.yaml `telemetry.enabled: false`
 * - Uses a random anonymous ID persisted locally (no PII)
 * - Never sends memory content, queries, or any user data
 * - Only sends aggregate counts, tool names, latencies, and version info
 *
 * Differentiator: uses event group `memos_local_hermes_v2` to cleanly
 * separate from v1 (`memos_local_hermes`) in ARMS dashboards.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { Logger } from "../logger/types.js";

export interface TelemetryConfig {
  enabled?: boolean;
}

interface TelemetryCredentials {
  endpoint: string;
  pid: string;
  env: string;
}

function loadTelemetryCredentials(pluginDir?: string): TelemetryCredentials {
  if (process.env.MEMOS_ARMS_ENDPOINT) {
    return {
      endpoint: process.env.MEMOS_ARMS_ENDPOINT,
      pid: process.env.MEMOS_ARMS_PID ?? "",
      env: process.env.MEMOS_ARMS_ENV ?? "prod",
    };
  }
  const bases = pluginDir ? [pluginDir, path.join(pluginDir, "src")] : [];
  if (typeof __dirname === "string") bases.push(path.resolve(__dirname, ".."), __dirname);
  const candidates = bases.map((b) => path.join(b, "telemetry.credentials.json"));
  for (const credPath of candidates) {
    try {
      const raw = fs.readFileSync(credPath, "utf-8");
      const creds = JSON.parse(raw) as Partial<TelemetryCredentials>;
      if (creds.endpoint) {
        return { endpoint: creds.endpoint, pid: creds.pid ?? "", env: creds.env ?? "prod" };
      }
    } catch {
      // Intentionally swallowed — try next candidate.
    }
  }
  return { endpoint: "", pid: "", env: "prod" };
}

const FLUSH_AT = 10;
const FLUSH_INTERVAL_MS = 30_000;
const SEND_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000;

const EVENT_GROUP = "memos_local_hermes_v2";
const EVENT_TYPE = "memos_plugin";
const VIEW_NAME = "memos-local-hermes-v2";

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

  constructor(
    config: TelemetryConfig,
    stateDir: string,
    pluginVersion: string,
    log: Logger,
    pluginDir?: string,
  ) {
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

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
    this.log.debug("Telemetry initialized (ARMS)");
  }

  // ─── State persistence ───

  private loadOrCreateAnonymousId(stateDir: string): string {
    const dir = path.join(stateDir, "memos-local");
    const idFile = path.join(dir, ".anonymous-id");
    try {
      const existing = fs.readFileSync(idFile, "utf-8").trim();
      if (existing.length > 10) return existing;
    } catch {
      // First run.
    }
    const newId = randomUUID();
    try {
      fs.mkdirSync(path.dirname(idFile), { recursive: true });
      fs.writeFileSync(idFile, newId, "utf-8");
    } catch {
      // Non-fatal.
    }
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
    } catch {
      // First session.
    }
    const newId = randomUUID();
    this.touchSession(filePath, newId);
    return newId;
  }

  private touchSession(filePath: string, id: string): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${Date.now()}|${id}`, "utf-8");
    } catch {
      // Non-fatal.
    }
  }

  private loadOrCreateFirstSeen(stateDir: string): string {
    const filePath = path.join(stateDir, "memos-local", ".first-seen");
    try {
      const existing = fs.readFileSync(filePath, "utf-8").trim();
      if (existing.length === 10) return existing;
    } catch {
      // First install.
    }
    const today = new Date().toISOString().slice(0, 10);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, today, "utf-8");
    } catch {
      // Non-fatal.
    }
    return today;
  }

  // ─── Core ───

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
      type: EVENT_TYPE,
      name: event,
      group: EVENT_GROUP,
      value: 1,
      properties: safeProps,
      timestamp: Date.now(),
      event_id: randomUUID(),
      times: 1,
    });

    if (this.buffer.length >= FLUSH_AT) {
      void this.flush();
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
      view: { id: "plugin", name: VIEW_NAME },
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

  trackPluginStarted(agentName: string): void {
    this.capture("plugin_started", { agent_name: agentName });
    this.maybeSendDailyPing();
  }

  trackTurnStart(agentName: string, latencyMs: number, hitCount: number): void {
    this.capture("memory_search", {
      agent_name: agentName,
      type: "turn_start",
      latency_ms: Math.round(latencyMs),
      hit_count: hitCount,
    });
  }

  trackTurnEnd(agentName: string, traceCount: number): void {
    this.capture("memory_ingested", {
      agent_name: agentName,
      trace_count: traceCount,
    });
  }

  trackMemorySearch(agentName: string, latencyMs: number, hitCount: number): void {
    this.capture("memory_search", {
      agent_name: agentName,
      type: "adhoc",
      latency_ms: Math.round(latencyMs),
      hit_count: hitCount,
    });
  }

  trackFeedback(agentName: string, feedbackType: string): void {
    this.capture("feedback_submitted", {
      agent_name: agentName,
      feedback_type: feedbackType,
    });
  }

  trackViewerOpened(): void {
    this.capture("viewer_opened");
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
    this.capture("daily_active", { first_seen_date: this.firstSeenDate });
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
