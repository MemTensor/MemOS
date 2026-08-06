import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pluginInstaller = fileURLToPath(new URL("../../install.sh", import.meta.url));
const legacyInstaller = fileURLToPath(
  new URL("../../../memos-local-openclaw/install.sh", import.meta.url),
);

interface InstallerHarness {
  root: string;
  home: string;
  bin: string;
  temp: string;
  gatewayLog: string;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

function createHarness(): InstallerHarness {
  const root = mkdtempSync(join(tmpdir(), "memos-installer-recovery-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const temp = join(root, "tmp");
  const gatewayLog = join(root, "gateway.log");
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(temp);

  writeExecutable(
    join(bin, "node"),
    'if [[ "${1:-}" == "-v" ]]; then printf "v22.0.0\\n"; fi\nexit 0',
  );
  writeExecutable(join(bin, "npx"), "exit 0");
  writeExecutable(
    join(bin, "npm"),
    `case "\${1:-}" in
  pack) exit "\${FAKE_NPM_PACK_EXIT:-0}" ;;
  install) mkdir -p node_modules/better-sqlite3; exit 0 ;;
  rebuild) exit 0 ;;
  *) exit 0 ;;
esac`,
  );
  writeExecutable(
    join(bin, "openclaw"),
    `printf '%s\\n' "$*" >> "\${FAKE_GATEWAY_LOG:?}"
if [[ "$*" == "gateway start" ]]; then
  exit "\${FAKE_GATEWAY_START_EXIT:-0}"
fi
exit 0`,
  );
  writeExecutable(join(bin, "sleep"), "exit 0");
  writeExecutable(join(bin, "lsof"), "exit 1");
  writeExecutable(join(bin, "curl"), "exit 0");

  return { root, home, bin, temp, gatewayLog };
}

function runInstaller(
  harness: InstallerHarness,
  script: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync("bash", [script, ...args], {
    cwd: harness.root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: harness.home,
      TMPDIR: harness.temp,
      PATH: `${harness.bin}:${process.env.PATH ?? ""}`,
      FAKE_GATEWAY_LOG: harness.gatewayLog,
    },
  });
}

function gatewayCalls(harness: InstallerHarness): string[] {
  if (!existsSync(harness.gatewayLog)) return [];
  return readFileSync(harness.gatewayLog, "utf8").trim().split("\n").filter(Boolean);
}

function expectTempCleaned(harness: InstallerHarness): void {
  expect(readdirSync(harness.temp)).toEqual([]);
}

describe.skipIf(process.platform === "win32")("installer gateway recovery", () => {
  it("restarts the gateway when the unified installer cannot extract the package", () => {
    const harness = createHarness();
    try {
      const brokenTarball = join(harness.root, "broken.tgz");
      writeFileSync(brokenTarball, "not a tarball", "utf8");

      const result = runInstaller(harness, pluginInstaller, [
        "--agent",
        "openclaw",
        "--version",
        brokenTarball,
      ]);

      expect(result.status).not.toBe(0);
      expect(gatewayCalls(harness)).toEqual(["gateway stop", "gateway start"]);
      expectTempCleaned(harness);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("warns when legacy-installer gateway recovery also fails", () => {
    const harness = createHarness();
    try {
      const result = runInstaller(
        harness,
        legacyInstaller,
        ["--version", "missing-test-version", "--openclaw-home", join(harness.home, ".openclaw")],
        { FAKE_GATEWAY_START_EXIT: "17", FAKE_NPM_PACK_EXIT: "23" },
      );

      expect(result.status).not.toBe(0);
      expect(gatewayCalls(harness)).toEqual(["gateway stop", "gateway start"]);
      expect(result.stderr).toContain("Gateway recovery start failed");
      expectTempCleaned(harness);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("does not retry a failed final gateway start from the exit trap", () => {
    const harness = createHarness();
    try {
      const packageRoot = join(harness.root, "package");
      const tarball = join(harness.root, "plugin.tgz");
      mkdirSync(packageRoot);
      writeFileSync(join(packageRoot, "package.json"), '{"name":"test-plugin"}\n', "utf8");
      const tar = spawnSync("tar", ["-czf", tarball, "-C", harness.root, "package"], {
        encoding: "utf8",
      });
      expect(tar.status, tar.stderr).toBe(0);

      const result = runInstaller(
        harness,
        legacyInstaller,
        ["--version", tarball, "--openclaw-home", join(harness.home, ".openclaw")],
        { FAKE_GATEWAY_START_EXIT: "17" },
      );

      expect(result.status).not.toBe(0);
      const calls = gatewayCalls(harness);
      expect(calls[0]).toBe("gateway stop");
      expect(calls.filter((call) => call === "gateway start")).toHaveLength(1);
      expect(result.stdout).toContain("Starting OpenClaw Gateway service");
      expect(result.stdout).not.toContain("OpenClaw Gateway started");
      expect(result.stdout).not.toContain("Start OpenClaw Gateway service");
      expect(result.stderr).toContain("Failed to start OpenClaw Gateway");
      expectTempCleaned(harness);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
