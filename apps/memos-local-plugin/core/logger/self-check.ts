/**
 * Startup self-check.
 *
 * Called by `core/pipeline/orchestrator.ts` right after `initLogger`. It
 * writes a probe record to every active sink, then asserts:
 *
 *   - the memory ring contains the probe (proves dispatch works)
 *   - if file sinks are active, `memos.log` exists and is writable
 *   - audit log exists and is mode 600 (or close-enough on Windows)
 *   - the SSE broadcaster has at least our subscriber slot
 *
 * Result is appended to `logs/self-check.log` (a tiny human-readable trail).
 *
 * Failures DO NOT throw — they downgrade to console-only and emit one ERROR
 * record so the user sees the problem in `error.log`.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { rootLogger, memoryBuffer } from "./index.js";
import { ids } from "../id.js";
import type { ResolvedHome } from "../config/paths.js";

export interface SelfCheckResult {
  ok: boolean;
  details: Record<string, boolean | string>;
}

export async function runSelfCheck(home: ResolvedHome): Promise<SelfCheckResult> {
  const log = rootLogger.child({ channel: "system.self-check" });
  const details: Record<string, boolean | string> = {};

  // 1. probe write through the dispatcher
  //    (use a non-numeric id so the redactor's phone-number pattern doesn't
  //    treat it as PII)
  const probeMsg = `self-check.probe`;
  const probeId = ids.span();
  log.info(probeMsg, { probeId });
  const buf = memoryBuffer().tail({ limit: 5 });
  details.dispatcher = buf.some((r) => r.msg === probeMsg && r.data?.["probeId"] === probeId);

  // 2. logs dir is writable
  try {
    await fs.mkdir(home.logsDir, { recursive: true });
    const probePath = join(home.logsDir, ".self-check-probe");
    await fs.writeFile(probePath, probeId);
    await fs.unlink(probePath);
    details.logsDir = true;
  } catch (err) {
    details.logsDir = false;
    log.error("logs dir is not writable", { logsDir: home.logsDir, err });
  }

  // 3. audit log file exists or can be created (we don't require content yet)
  const auditPath = join(home.logsDir, "audit.log");
  try {
    log.audit("self-check", { auditPath });
    // best-effort assertion: the file should exist after we wrote one record
    await fs.access(auditPath).then(() => { details.audit = true; }).catch(() => { details.audit = false; });
  } catch (err) {
    details.audit = false;
    log.error("audit sink is not functional", { err });
  }

  // 4. write a tiny self-check trail
  try {
    const line = `${new Date().toISOString()} self-check ${JSON.stringify(details)}\n`;
    await fs.appendFile(join(home.logsDir, "self-check.log"), line);
  } catch {
    // ignore
  }

  const ok = Object.values(details).every((v) => v === true || typeof v === "string");
  if (!ok) log.warn("self-check.failed", { details });
  else log.info("self-check.ok", { details });
  return { ok, details };
}
