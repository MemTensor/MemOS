import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ARMS_UID_FILE = new URL("../.memos_arms_uid", import.meta.url);
const TELEMETRY_CREDENTIALS_FILE = new URL("../telemetry.credentials.json", import.meta.url);

let armsUidCache = "";
let telemetryCredentialsCache;

function loadTelemetryCredentials(log) {
  if (telemetryCredentialsCache) return telemetryCredentialsCache;
  if (process.env.MEMOS_ARMS_ENDPOINT) {
    telemetryCredentialsCache = {
      endpoint: String(process.env.MEMOS_ARMS_ENDPOINT || "").trim(),
      pid: String(process.env.MEMOS_ARMS_PID || "").trim(),
      env: String(process.env.MEMOS_ARMS_ENV || "prod").trim() || "prod",
    };
  } else {
    try {
      const parsed = JSON.parse(readFileSync(TELEMETRY_CREDENTIALS_FILE, "utf-8"));
      telemetryCredentialsCache = {
        endpoint: String(parsed.endpoint || "").trim(),
        pid: String(parsed.pid || "").trim(),
        env: String(parsed.env || "prod").trim() || "prod",
      };
    } catch {
      telemetryCredentialsCache = { endpoint: "", pid: "", env: "prod" };
    }
  }
  if (!telemetryCredentialsCache.endpoint || !telemetryCredentialsCache.pid) {
    log?.debug?.("[memos-cloud] RUM disabled: telemetry credentials are incomplete.");
  }
  return telemetryCredentialsCache;
}

function readUidFromFile() {
  try {
    return readFileSync(ARMS_UID_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

function writeUidToFile(value) {
  try {
    writeFileSync(ARMS_UID_FILE, `${value}\n`, { mode: 0o600 });
  } catch {}
}

function createEventId() {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}`;
}

function readOpenClawDeviceId(log) {
  try {
    const deviceFile = join(homedir(), ".openclaw", "identity", "device.json");
    const content = readFileSync(deviceFile, "utf-8");
    const data = JSON.parse(content);
    if (data && typeof data.deviceId === "string" && data.deviceId.trim()) {
      return `uid_${data.deviceId.trim()}`;
    }
  } catch (err) {
    log?.warn?.(`[memos-cloud] Failed to read OpenClaw deviceId: ${String(err)}`);
  }
  return "";
}

function loadArmsUid(log) {
  if (armsUidCache) return armsUidCache;

  const openclawDevice = readOpenClawDeviceId(log);
  if (openclawDevice) {
    armsUidCache = openclawDevice;
    writeUidToFile(armsUidCache);
    return armsUidCache;
  }

  const fromUidFile = readUidFromFile();
  if (fromUidFile) {
    armsUidCache = fromUidFile;
    return armsUidCache;
  }

  armsUidCache = `uid_${randomUUID()}`;
  writeUidToFile(armsUidCache);
  return armsUidCache;
}

function buildPayload(ctx, eventName, payload, log, credentials) {
  return {
    app: {
      id: credentials.pid,
      env: credentials.env,
      type: "node",
    },
    user: { id: loadArmsUid(log) },
    session: { id: ctx.sessionId },
    net: {},
    view: { id: "plugin", name: "memos-cloud-openclaw" },
    events: [
      {
        event_id: createEventId(),
        event_type: 'custom',
        type: "memos_plugin",
        group: "memos_cloud",
        name: eventName,
        timestamp: +new Date(),
        properties: { ...payload }
      }
    ]
  };
}

export async function reportRumEvent(eventName, payload, cfg, ctx, log) {
  if (!cfg.rumEnabled) return;
  const credentials = loadTelemetryCredentials(log);
  if (!credentials.endpoint || !credentials.pid) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Number.isFinite(cfg.rumTimeoutMs) ? Math.max(1000, cfg.rumTimeoutMs) : 3000,
  );
  try {
    const body = buildPayload(ctx, eventName, payload, log, credentials);
    const res = await fetch(credentials.endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    log.warn?.(`[memos-cloud] RUM report failed: ${String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
