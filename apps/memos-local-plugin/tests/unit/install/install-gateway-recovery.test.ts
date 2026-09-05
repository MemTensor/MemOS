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
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const INSTALLER = path.join(REPO_ROOT, "install.sh");

interface InstallerFixture {
  root: string;
  home: string;
  bin: string;
  temp: string;
  gatewayLog: string;
  env: NodeJS.ProcessEnv;
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, `#!/usr/bin/env bash\nset -u\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
}

function createFixture(): InstallerFixture {
  const root = mkdtempSync(path.join(tmpdir(), "memos-installer-recovery-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const temp = path.join(root, "tmp");
  const gatewayLog = path.join(root, "gateway.log");
  mkdirSync(path.join(home, ".openclaw"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(temp);

  writeExecutable(
    path.join(bin, "node"),
    `if [[ "\${1:-}" == "-v" ]]; then
  printf 'v22.0.0\\n'
elif [[ "\${1:-}" == "-p" ]]; then
  printf '1.0.0\\n'
fi
exit 0`,
  );
  writeExecutable(
    path.join(bin, "npm"),
    `if [[ "\${1:-}" == "install" ]]; then
  mkdir -p node_modules/better-sqlite3
fi
exit 0`,
  );
  writeExecutable(
    path.join(bin, "openclaw"),
    `printf '%s\\n' "$*" >> "\${FAKE_GATEWAY_LOG:?}"
if [[ "$*" == "gateway start" ]]; then
  if [[ "\${FAKE_GATEWAY_START_EXIT:-0}" != "0" ]]; then
    printf 'fake gateway start failure\\n' >&2
  fi
  exit "\${FAKE_GATEWAY_START_EXIT:-0}"
fi
exit 0`,
  );
  writeExecutable(path.join(bin, "sleep"), "exit 0");
  writeExecutable(path.join(bin, "lsof"), "exit 1");
  writeExecutable(path.join(bin, "curl"), 'exit "${FAKE_CURL_EXIT:-0}"');

  return {
    root,
    home,
    bin,
    temp,
    gatewayLog,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GATEWAY_LOG: gatewayLog,
    },
  };
}

function runInstaller(
  fixture: InstallerFixture,
  version: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    "bash",
    [INSTALLER, "--agent", "openclaw", "--version", version],
    {
      cwd: fixture.root,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...fixture.env, ...extraEnv },
    },
  );
}

function gatewayCalls(fixture: InstallerFixture): string[] {
  if (!existsSync(fixture.gatewayLog)) return [];
  return readFileSync(fixture.gatewayLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
}

function expectTemporaryDirectoriesCleaned(fixture: InstallerFixture): void {
  expect(readdirSync(fixture.temp)).toEqual([]);
}

function createValidPackage(fixture: InstallerFixture): string {
  const packageRoot = path.join(fixture.root, "package");
  const runtimeDir = path.join(packageRoot, "dist", "adapters", "openclaw");
  const tarball = path.join(fixture.root, "plugin.tgz");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    '{"name":"test-plugin","version":"1.0.0"}\n',
    "utf8",
  );
  writeFileSync(path.join(runtimeDir, "index.js"), "export {};\n", "utf8");
  const result = spawnSync(
    "tar",
    ["-czf", tarball, "-C", fixture.root, "package"],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return tarball;
}

describe.skipIf(process.platform === "win32")(
  "unified installer gateway recovery",
  () => {
    it("restarts the gateway when package extraction fails after it was stopped", () => {
      const fixture = createFixture();
      try {
        const brokenTarball = path.join(fixture.root, "broken.tgz");
        writeFileSync(brokenTarball, "not a tarball", "utf8");

        const result = runInstaller(fixture, brokenTarball);

        expect(result.status).toBe(1);
        expect(gatewayCalls(fixture)).toEqual([
          "gateway stop",
          "gateway start",
        ]);
        expectTemporaryDirectoriesCleaned(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("reports a failed recovery start without masking the install failure", () => {
      const fixture = createFixture();
      try {
        const brokenTarball = path.join(fixture.root, "broken.tgz");
        writeFileSync(brokenTarball, "not a tarball", "utf8");

        const result = runInstaller(fixture, brokenTarball, {
          FAKE_GATEWAY_START_EXIT: "17",
        });

        expect(result.status).toBe(1);
        expect(gatewayCalls(fixture)).toEqual([
          "gateway stop",
          "gateway start",
        ]);
        expect(result.stderr).toContain("OpenClaw gateway recovery failed");
        expect(result.stderr).toContain("fake gateway start failure");
        expectTemporaryDirectoriesCleaned(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("does not retry the normal final gateway start from exit cleanup", () => {
      const fixture = createFixture();
      try {
        const tarball = createValidPackage(fixture);

        const result = runInstaller(fixture, tarball, {
          FAKE_CURL_EXIT: "1",
          FAKE_GATEWAY_START_EXIT: "17",
        });

        expect(result.status).not.toBe(0);
        expect(gatewayCalls(fixture)).toEqual([
          "gateway stop",
          "gateway start",
        ]);
        expect(result.stderr).toContain("openclaw gateway start failed");
        expectTemporaryDirectoriesCleaned(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("disarms recovery after the normal gateway start succeeds", () => {
      const fixture = createFixture();
      try {
        const tarball = createValidPackage(fixture);

        const result = runInstaller(fixture, tarball);

        expect(result.status).toBe(0);
        expect(gatewayCalls(fixture)).toEqual([
          "gateway stop",
          "gateway start",
        ]);
        expectTemporaryDirectoriesCleaned(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  },
);
