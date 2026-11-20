/**
 * Regression test for issue #1736.
 *
 * The historical failure mode on Node ≥ 22 was:
 *
 *   bridge: fatal: Cannot read properties of undefined (reading 'exports')
 *     at load (node:internal/modules/cjs/loader:...)
 *
 * Root cause was the CommonJS `dist/bridge.cjs` trampoline trying to
 * load ESM peers via either `__dirname`-rooted `.ts` paths or
 * `require(file://...)`. The fix introduces a pure-ESM
 * `dist/bridge.mjs` entry that imports the same peers via plain
 * relative specifiers. This test spawns the new entry and asserts that
 * the historical symptom string never appears on stderr within a short
 * grace period — failures further downstream (e.g. a missing
 * better-sqlite3 native binding when running in a clean CI sandbox)
 * are tolerated because they are unrelated to issue #1736.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORBIDDEN_SYMPTOM =
  "Cannot read properties of undefined (reading 'exports')";

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const BRIDGE_MJS = path.join(PLUGIN_ROOT, "dist", "bridge.mjs");

interface SpawnResult {
  stderr: string;
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function spawnBridge(
  args: readonly string[],
  options: { home: string; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BRIDGE_MJS, ...args], {
      env: {
        ...process.env,
        HOME: options.home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    proc.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });

    const killer = setTimeout(() => {
      // Bridge survived the grace window without emitting the
      // forbidden symptom — kill it so the test does not hang.
      try {
        proc.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }, options.timeoutMs);

    proc.once("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    proc.once("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code, signal });
    });

    // Close stdin so a clean stdio bridge can finish startup without
    // blocking on a non-existent JSON-RPC stream.
    proc.stdin?.end();
  });
}

describe("Issue #1736 — bridge ESM entry boots without CJS 'exports' error", () => {
  it("dist/bridge.mjs starts up without the historical CJS/ESM symptom", async () => {
    // The build step is a precondition for this test. The repository
    // CI runs `pnpm build` before vitest; locally the user should
    // either run `pnpm build` once, or accept that this test will
    // skip when the artifact is missing.
    if (!fs.existsSync(BRIDGE_MJS)) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memos-1736-"));
    try {
      const result = await spawnBridge(["--agent=hermes", "--no-viewer"], {
        home,
        timeoutMs: 8_000,
      });

      // Combined output check — the symptom is unique enough that it
      // never appears in healthy startup logs.
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain(FORBIDDEN_SYMPTOM);

      // Sanity: the bridge must at least have started the ESM import
      // chain. Either the headless-mode notice fires on success, or
      // the unrelated better-sqlite3 native-binding error fires when
      // the native module is absent (CI sandbox without postinstall).
      // The historic CJS trampoline crash would surface BEFORE either
      // of those.
      const reachedEsmPath =
        combined.includes("stdio mode running without viewer") ||
        combined.includes("Could not locate the bindings file") ||
        combined.includes("bootstrapMemoryCoreFull") ||
        combined.includes("[core.pipeline.bootstrap]");
      expect(
        reachedEsmPath,
        `bridge did not reach the post-trampoline path; stderr was:\n${result.stderr}`,
      ).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
