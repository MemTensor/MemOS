import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ARMS_ENDPOINT = "https://proj-xtrace-e218d9316b328f196a3c640cc7ca84-cn-hangzhou.cn-hangzhou.log.aliyuncs.com/rum/web/v2?workspace=default-cms-1026429231103299-cn-hangzhou&service_id=a3u72ukxmr@bed68dd882dd823439015"
const ARMS_PID = "a3u72ukxmr@c42a249fb14f4d9";
const ARMS_ENV = "prod";
const ARMS_UID_FILE = new URL("../.memos_arms_uid", import.meta.url);

let armsUidCache = "";

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

function buildPayload(ctx, eventName, payload, log) {
  return {
    app: {
      id: ARMS_PID,
      env: ARMS_ENV,
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
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Number.isFinite(cfg.rumTimeoutMs) ? Math.max(1000, cfg.rumTimeoutMs) : 3000,
  );
  try {
    const body = buildPayload(ctx, eventName, payload, log);
    const res = await fetch(ARMS_ENDPOINT, {
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
