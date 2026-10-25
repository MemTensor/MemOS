/**
 * Daemon start-log cap tests (issue #2379).
 *
 * The daemon's stdout/stderr is a plain shell redirect (install.sh) or
 * Start-Process redirection (install.ps1), so the plugin's rotating file
 * logger never sees it. The installers must cap the file themselves before
 * every daemon launch.
 *
 * Verified here without side effects on the host:
 *   1. `rotate_oversized_log` (extracted verbatim from install.sh) rolls an
 *      over-cap log to a single `.1` generation and leaves small, missing,
 *      and unreadable files untouched.
 *   2. Every daemon launch site routes through the cap: the Hermes bridge
 *      redirect and the OpenClaw gateway fallback redirect in install.sh,
 *      and both Start-Process redirects in install.ps1.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const INSTALL_SH = path.join(REPO_ROOT, "install.sh");
const INSTALL_PS1 = path.join(REPO_ROOT, "install.ps1");

/** Extract the `rotate_oversized_log` function body verbatim from install.sh. */
function extractRotateFunction(): string {
  const script = readFileSync(INSTALL_SH, "utf8");
  const start = script.indexOf("rotate_oversized_log() {");
  if (start < 0) throw new Error("rotate_oversized_log() not found in install.sh");
  const end = script.indexOf("\n}\n", start);
  if (end < 0) throw new Error("rotate_oversized_log() has no closing brace");
  return script.slice(start, end + 3);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One isolated temp dir + a runner that executes the extracted function. */
function makeSandbox(): { root: string; run(scriptBody: string): RunResult } {
  const root = mkdtempSync(path.join(tmpdir(), "memos-daemon-log-cap-"));
  return {
    root,
    run(scriptBody: string): RunResult {
      const r = spawnSync("bash", ["-c", `${extractRotateFunction()}\n${scriptBody}`], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

function makeLog(dir: string, name: string, bytes: number): string {
  const file = path.join(dir, name);
  writeFileSync(file, "x".repeat(bytes), "utf8");
  return file;
}

describe("install.sh — rotate_oversized_log behavior", () => {
  it("rolls an over-cap log to .1 and starts a fresh active file", () => {
    const sandbox = makeSandbox();
    const log = makeLog(sandbox.root, "daemon-start.log", 64);
    try {
      const r = sandbox.run(`rotate_oversized_log "${log}" 32`);
      expect(r.code).toBe(0);
      // The rolled generation keeps only the tail, bounded at the cap —
      // the pre-rotation file can be arbitrarily larger than the cap.
      expect(readFileSync(`${log}.1`, "utf8")).toHaveLength(32);
      expect(readFileSync(log, "utf8")).toHaveLength(0);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("leaves a log at or under the cap untouched", () => {
    const sandbox = makeSandbox();
    const log = makeLog(sandbox.root, "daemon-start.log", 32);
    try {
      const r = sandbox.run(`rotate_oversized_log "${log}" 32`);
      expect(r.code).toBe(0);
      expect(readFileSync(log, "utf8")).toHaveLength(32);
      expect(() => readFileSync(`${log}.1`, "utf8")).toThrow();
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("is a no-op for a missing log", () => {
    const sandbox = makeSandbox();
    try {
      const log = path.join(sandbox.root, "absent.log");
      const r = sandbox.run(`rotate_oversized_log "${log}" 32`);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("keeps exactly one rotated generation across repeated launches", () => {
    const sandbox = makeSandbox();
    try {
      const log = makeLog(sandbox.root, "daemon-start.log", 64);
      sandbox.run(`rotate_oversized_log "${log}" 32`);
      // The fresh active file grows past the cap again before the next launch.
      makeLog(sandbox.root, "daemon-start.log", 48);
      sandbox.run(`rotate_oversized_log "${log}" 32`);
      expect(readFileSync(`${log}.1`, "utf8")).toHaveLength(32);
      expect(readFileSync(log, "utf8")).toHaveLength(0);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("survives an unreadable log without failing the launch path", () => {
    const sandbox = makeSandbox();
    const log = makeLog(sandbox.root, "daemon-start.log", 64);
    try {
      chmodSync(log, 0o000);
      const r = sandbox.run(`rotate_oversized_log "${log}" 32`);
      expect(r.code).toBe(0);
    } finally {
      chmodSync(log, 0o644);
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("uses a 10 MB script default cap", () => {
    const script = readFileSync(INSTALL_SH, "utf8");
    expect(script).toContain("DAEMON_LOG_MAX_BYTES=$((10 * 1024 * 1024))");
  });
});

describe("daemon launch sites route through the cap", () => {
  it("caps daemon-start.log before the Hermes bridge redirect in install.sh", () => {
    const script = readFileSync(INSTALL_SH, "utf8");
    const rotation = script.indexOf('rotate_oversized_log "${daemon_log}"');
    const launch = script.indexOf(
      'nohup "${node_bin}" "${bridge_entry}" --agent=hermes --daemon',
    );
    const logDecl = script.indexOf('local daemon_log="${prefix}/logs/daemon-start.log"');
    expect(logDecl).toBeGreaterThan(0);
    expect(rotation).toBeGreaterThan(logDecl);
    expect(launch).toBeGreaterThan(rotation);
  });

  it("caps the OpenClaw gateway fallback log in install.sh", () => {
    const script = readFileSync(INSTALL_SH, "utf8");
    const launch = script.indexOf('nohup "${oc_bin}" gateway >/tmp/openclaw-memos-gateway.log');
    expect(launch).toBeGreaterThan(0);
    const before = script.slice(Math.max(0, launch - 200), launch);
    expect(before).toContain("rotate_oversized_log /tmp/openclaw-memos-gateway.log");
  });

  it("caps both daemon start redirects in install.ps1", () => {
    const script = readFileSync(INSTALL_PS1, "utf8");
    expect(script).toContain("function Reset-OversizedLog");
    const firstLaunch = script.indexOf("Start-Process -FilePath $NodeBin");
    expect(firstLaunch).toBeGreaterThan(0);
    const before = script.slice(0, firstLaunch);
    expect(before).toContain("Reset-OversizedLog -Path $DaemonLog");
    expect(before).toContain("Reset-OversizedLog -Path $DaemonLogErr");
  });
});
