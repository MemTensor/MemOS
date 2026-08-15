/**
 * install.sh smoke tests.
 *
 * The installer exposes a small target/version/profile CLI plus an
 * interactive picker (ENTER = legacy auto-detect). It patches real host files
 * (~/.openclaw/openclaw.json etc.) and stops / starts the agent gateway,
 * so we deliberately keep unit tests narrow — they only exercise what
 * can be checked without side effects on the developer's machine:
 *
 *   1. `--help` exits 0 and prints the usage banner.
 *   2. An unknown flag exits non-zero.
 *   3. Removed legacy flags report an error cleanly.
 *
 * OpenClaw/Hermes end-to-end behaviour is verified manually. DSH's package
 * manager boundary is covered here with an isolated HOME and fake executables,
 * including the exact `curl | bash` stdin shape used by the public installer.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "install.sh");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function runViaStdin(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-s", "--", ...args], {
    env: { ...process.env, ...env },
    input: readFileSync(SCRIPT, "utf8"),
    encoding: "utf8",
    timeout: 10_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function writeExecutable(file: string, source: string): void {
  writeFileSync(file, source, "utf8");
  chmodSync(file, 0o755);
}

function findHostExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the host PATH.
    }
  }
  throw new Error(`Required test executable not found: ${name}`);
}

function isolateFixturePath(bin: string): void {
  for (const name of [
    "awk",
    "bash",
    "basename",
    "cat",
    "chmod",
    "cut",
    "dirname",
    "grep",
    "mkdir",
    "mktemp",
    "rm",
    "sed",
    "tee",
    "uname",
  ]) {
    symlinkSync(findHostExecutable(name), path.join(bin, name));
  }
  writeExecutable(
    path.join(bin, "node"),
    `#!/usr/bin/env bash
if [[ "$1" == "-v" ]]; then
  printf '%s\n' 'v22.19.0'
elif [[ "$1" == "-p" ]]; then
  printf '%s\n' '22.19.0'
else
  exit 64
fi
`,
  );
}

function makeDshFixture(options: {
  firstAdd?: "success" | "ignored-builds" | "unknown-build" | "error";
  approval?: "success" | "error";
  secondAdd?: "success" | "error";
  dump?: "success" | "missing-bundle";
  pnpm?: "present" | "missing";
  npmBootstrap?: "success" | "error";
  sqliteProbe?: "success" | "repairable" | "error";
  onnxProbe?: "success" | "error";
  rebuild?: "success" | "error";
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "memos-dsh-installer-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const dshHome = path.join(home, ".dsh");
  const profileWorkspace = path.join(
    dshHome,
    "profiles",
    "web",
    "pnpm-workspace.yaml",
  );
  const log = path.join(root, "dsh.log");
  const dshEnvLog = path.join(root, "dsh-env.log");
  const addCount = path.join(root, "add-count");
  const npmLog = path.join(root, "npm.log");
  const npmPrefixLog = path.join(root, "npm-prefix.log");
  const pnpmActionLog = path.join(root, "pnpm-actions.log");
  const nativeProbeLog = path.join(root, "native-probes.log");
  const rebuildMarker = path.join(root, "better-sqlite3-rebuilt");
  const scratch = path.join(root, "scratch");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  mkdirSync(path.dirname(profileWorkspace), { recursive: true });
  writeFileSync(
    profileWorkspace,
    "packages:\n  - .\nallowBuilds:\n  onnxruntime-node: true\n",
    "utf8",
  );
  const hostNode = findHostExecutable("node");

  const pnpm = options.pnpm ?? "present";
  if (pnpm === "present") {
    const rebuild = options.rebuild ?? "success";
    writeExecutable(
      path.join(bin, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\n' '11.7.0'
  exit 0
fi
printf '%s\n' "$*" >> "${pnpmActionLog}"
if [[ "$*" == "rebuild better-sqlite3" ]]; then
  [[ "${rebuild}" == "success" ]] || exit 92
  : > "${rebuildMarker}"
  exit 0
fi
exit 64
`,
    );
  } else {
    isolateFixturePath(bin);
    const npmBootstrap = options.npmBootstrap ?? "success";
    writeExecutable(
      path.join(bin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${npmLog}"
[[ "${npmBootstrap}" == "success" ]] || exit 90

prefix=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--prefix" ]]; then
    shift
    prefix="$1"
    break
  fi
  shift
done
[[ -n "$prefix" ]] || exit 91
printf '%s\n' "$prefix" > "${npmPrefixLog}"
mkdir -p "$prefix/node_modules/.bin"
printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' '11.7.0'" > "$prefix/node_modules/.bin/pnpm"
chmod +x "$prefix/node_modules/.bin/pnpm"
`,
    );
  }

  const sqliteProbe = options.sqliteProbe ?? "success";
  const onnxProbe = options.onnxProbe ?? "success";
  writeExecutable(
    path.join(bin, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf '%s\n' 'v22.19.0'
  exit 0
fi
if [[ "\${1:-}" == "-p" ]]; then
  printf '%s\n' '22.19.0'
  exit 0
fi
if [[ "\${1:-}" == "-e" ]]; then
  source="\${2:-}"
  if [[ "$source" == *"MEMOS_DSH_POLICY"* || "$source" == *"MEMOS_DSH_HOME"* ]]; then
    exec "${hostNode}" "$@"
  fi
  if [[ "$source" == *"better-sqlite3"* ]]; then
    printf '%s\n' 'better-sqlite3' >> "${nativeProbeLog}"
    if [[ "${sqliteProbe}" == "error" ]]; then exit 81; fi
    if [[ "${sqliteProbe}" == "repairable" && ! -f "${rebuildMarker}" ]]; then exit 81; fi
    exit 0
  fi
  if [[ "$source" == *"onnxruntime-node"* ]]; then
    printf '%s\n' 'onnxruntime-node' >> "${nativeProbeLog}"
    [[ "${onnxProbe}" == "success" ]] || exit 82
    exit 0
  fi
fi
exit 64
`,
  );

  const firstAdd = options.firstAdd ?? "ignored-builds";
  const approval = options.approval ?? "success";
  const secondAdd = options.secondAdd ?? "success";
  const dump = options.dump ?? "success";
  writeExecutable(
    path.join(bin, "dsh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${log}"
if [[ "\${1:-}" == "plugin" ]]; then
  printf '%s\\n' "\${ONNXRUNTIME_NODE_INSTALL:-}" >> "${dshEnvLog}"
fi

if [[ "$*" == "--profile web --dump-config" ]]; then
  if [[ "${dump}" == "missing-bundle" ]]; then
    printf '%s\\n' '# no external bundle'
    exit 0
  fi
  printf '%s\\n' '# bundle: @memtensor/memos-local-plugin' '  - id: memos-local-memory'
  exit 0
fi

if [[ "$1" == "plugin" && "$4" == "add" ]]; then
  profile="${dshHome}/profiles/web"
  mkdir -p "$profile"
  count=0
  [[ -f "${addCount}" ]] && count="$(cat "${addCount}")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "${addCount}"
  if [[ "$count" == "1" && "${firstAdd}" == "error" ]]; then
    printf '%s\\n' '[E_NETWORK] registry unavailable' >&2
    exit 42
  fi
  if [[ "$count" == "1" && "${firstAdd}" != "success" ]]; then
    if [[ "${firstAdd}" == "unknown-build" ]]; then
      pending="  unexpected-native-addon: set this to true or false"
    else
      pending="  '@memtensor/memos-local-plugin': set this to true or false
  better-sqlite3: set this to true or false
  esbuild: set this to true or false
  onnxruntime-node: set this to true or false
  protobufjs: set this to true or false
  sharp: set this to true or false"
    fi
    printf '%s\\n' 'packages:' '  - .' 'allowBuilds:' "$pending" > "$profile/pnpm-workspace.yaml"
    printf '%s\\n' '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts' >&2
    exit 1
  fi
  if [[ "$count" == "2" && "${secondAdd}" == "error" ]]; then
    printf '%s\\n' '[E_SECOND_ADD] retry failed' >&2
    exit 43
  fi
  exit 0
fi

if [[ "$1" == "plugin" && "$4" == "approve-builds" ]]; then
  [[ "${approval}" == "success" ]] || exit 44
  exit 0
fi

exit 64
`,
  );

  return {
    root,
    home,
    bin,
    dshHome,
    log,
    dshEnvLog,
    npmLog,
    npmPrefixLog,
    pnpmActionLog,
    nativeProbeLog,
    profileWorkspace,
    env: {
      HOME: home,
      DSH_HOME: dshHome,
      TMPDIR: scratch,
      XDG_CACHE_HOME: path.join(scratch, "xdg-cache"),
      XDG_CONFIG_HOME: path.join(scratch, "xdg-config"),
      npm_config_cache: path.join(scratch, "npm-cache"),
      PATH: pnpm === "missing" ? bin : `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

describe("install.sh — CLI surface", () => {
  it("prints usage on --help and exits 0", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--version");
    expect(r.stdout).toContain("--agent dsh");
    expect(r.stdout).toContain("--profile");
    expect(r.stdout).not.toContain("bash install.sh --port");
  });

  it("prints usage on -h and exits 0", () => {
    const r = run(["-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  it("rejects unknown arguments with non-zero exit", () => {
    const r = run(["blobfish"]);
    expect(r.code).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
    expect(combined).toContain("unknown argument");
  });

  it("rejects --uninstall (removed from this version)", () => {
    // Older scripts supported `--uninstall`; the new minimal CLI drops
    // it to keep the surface to just `--version` + `--port`. This test
    // guards against us accidentally re-adding the flag without updating
    // the docs/tests alongside it.
    const r = run(["--uninstall", "openclaw"]);
    expect(r.code).not.toBe(0);
  });

  it("rejects --port (fixed per-agent ports are used)", () => {
    const r = run(["--port", "18799"]);
    expect(r.code).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain("--port is no longer supported");
  });

  it("installs DSH from one command with a reviewed, fail-closed build approval", () => {
    const fixture = makeDshFixture();
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");

      const r = run(
        ["--agent", "dsh", "--profile", "web", "--version", tarball],
        fixture.env,
      );

      expect(r.code).toBe(0);
      const calls = readFileSync(fixture.log, "utf8").trim().split("\n");
      expect(calls).toEqual([
        `plugin --profile web add ${tarball}`,
        "plugin --profile web approve-builds better-sqlite3 esbuild sharp !onnxruntime-node !protobufjs !@memtensor/memos-local-plugin",
        `plugin --profile web add ${tarball}`,
        "--profile web --dump-config",
      ]);
      expect(readFileSync(fixture.nativeProbeLog, "utf8").trim().split("\n")).toEqual([
        "better-sqlite3",
        "onnxruntime-node",
      ]);
      expect(readFileSync(fixture.dshEnvLog, "utf8").trim().split("\n")).toEqual([
        "skip",
        "skip",
        "skip",
      ]);
      expect(readFileSync(fixture.profileWorkspace, "utf8")).toContain(
        "onnxruntime-node: false",
      );
      expect(r.stdout).toContain("DeepSeek Harness install complete");
      expect(r.stdout).toContain("http://127.0.0.1:18801");
      expect(r.stdout).toContain("Viewer after restart:");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when pnpm reports an unreviewed build script", () => {
    const fixture = makeDshFixture({ firstAdd: "unknown-build" });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");

      const r = run(
        ["--agent", "dsh", "--profile", "web", "--version", tarball],
        fixture.env,
      );

      expect(r.code).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toContain("unexpected-native-addon");
      const calls = readFileSync(fixture.log, "utf8").trim().split("\n");
      expect(calls).toEqual([`plugin --profile web add ${tarball}`]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("passes a registry version straight to DSH without staging it through npm pack", () => {
    const fixture = makeDshFixture({ firstAdd: "success" });
    try {
      const npmLog = path.join(fixture.root, "npm.log");
      writeExecutable(
        path.join(fixture.bin, "npm"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${npmLog}"
exit 90
`,
      );

      const r = run(
        ["--agent", "dsh", "--version", "2.0.16-beta.1"],
        { ...fixture.env, DSH_HOME: "~/.dsh" },
      );

      expect(r.code).toBe(0);
      expect(existsSync(npmLog)).toBe(false);
      const calls = readFileSync(fixture.log, "utf8").trim().split("\n");
      expect(calls[0]).toBe(
        "plugin --profile web add @memtensor/memos-local-plugin@2.0.16-beta.1",
      );
      expect(calls).toHaveLength(2);
      expect(readFileSync(fixture.dshEnvLog, "utf8").trim()).toBe("skip");
      expect(readFileSync(fixture.profileWorkspace, "utf8")).toContain(
        "onnxruntime-node: false",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("prepares pinned temporary pnpm when it is missing", () => {
    const fixture = makeDshFixture({ firstAdd: "success", pnpm: "missing" });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");

      const r = run(["--agent", "dsh", "--version", tarball], fixture.env);

      expect(r.code).toBe(0);
      expect(readFileSync(fixture.npmLog, "utf8")).toContain(
        "install --prefix ",
      );
      expect(readFileSync(fixture.npmLog, "utf8")).toContain(
        "--no-save --ignore-scripts --no-audit --no-fund --package-lock=false --loglevel=error pnpm@11.7.0",
      );
      const temporaryPrefix = readFileSync(
        fixture.npmPrefixLog,
        "utf8",
      ).trim();
      expect(existsSync(temporaryPrefix)).toBe(false);
      expect(r.stdout).toContain("Temporary pnpm 11.7.0 ready");
      expect(readFileSync(fixture.log, "utf8")).toContain(
        `plugin --profile web add ${tarball}`,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails before calling DSH when temporary pnpm cannot be prepared", () => {
    const fixture = makeDshFixture({
      firstAdd: "success",
      pnpm: "missing",
      npmBootstrap: "error",
    });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");

      const r = run(["--agent", "dsh", "--version", tarball], fixture.env);

      expect(r.code).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toContain(
        "npm install -g pnpm@11.7.0",
      );
      expect(existsSync(fixture.log)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not approve builds after an unrelated DSH add failure", () => {
    const fixture = makeDshFixture({ firstAdd: "error" });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");
      const r = run(["--agent", "dsh", "--version", tarball], fixture.env);

      expect(r.code).not.toBe(0);
      expect(readFileSync(fixture.log, "utf8").trim()).toBe(
        `plugin --profile web add ${tarball}`,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not retry installation when reviewed build approval fails", () => {
    const fixture = makeDshFixture({ approval: "error" });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");
      const r = run(["--agent", "dsh", "--version", tarball], fixture.env);

      expect(r.code).not.toBe(0);
      const calls = readFileSync(fixture.log, "utf8").trim().split("\n");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("approve-builds");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("repairs a missing DSH better-sqlite3 binding before reporting success", () => {
    const fixture = makeDshFixture({
      firstAdd: "success",
      sqliteProbe: "repairable",
    });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");

      const r = run(["--agent", "dsh", "--version", tarball], fixture.env);

      expect(r.code).toBe(0);
      expect(readFileSync(fixture.pnpmActionLog, "utf8").trim()).toBe(
        "rebuild better-sqlite3",
      );
      expect(readFileSync(fixture.nativeProbeLog, "utf8").trim().split("\n")).toEqual([
        "better-sqlite3",
        "better-sqlite3",
        "onnxruntime-node",
      ]);
      expect(r.stdout).toContain("better-sqlite3 native binding repaired");
      expect(r.stdout).toContain("DeepSeek Harness install complete");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails DSH installation when the targeted better-sqlite3 rebuild fails", () => {
    const fixture = makeDshFixture({
      firstAdd: "success",
      sqliteProbe: "repairable",
      rebuild: "error",
    });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");

      const r = run(["--agent", "dsh", "--version", tarball], fixture.env);

      expect(r.code).not.toBe(0);
      expect(readFileSync(fixture.pnpmActionLog, "utf8").trim()).toBe(
        "rebuild better-sqlite3",
      );
      expect(`${r.stdout}\n${r.stderr}`).toContain(
        "better-sqlite3 rebuild failed",
      );
      expect(r.stdout).not.toContain("DeepSeek Harness install complete");
      expect(r.stdout).not.toContain("MemOS Local installed successfully");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails DSH installation when better-sqlite3 remains unusable after rebuild", () => {
    const fixture = makeDshFixture({
      firstAdd: "success",
      sqliteProbe: "error",
    });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");

      const r = run(["--agent", "dsh", "--version", tarball], fixture.env);

      expect(r.code).not.toBe(0);
      expect(readFileSync(fixture.pnpmActionLog, "utf8").trim()).toBe(
        "rebuild better-sqlite3",
      );
      expect(readFileSync(fixture.nativeProbeLog, "utf8").trim().split("\n")).toEqual([
        "better-sqlite3",
        "better-sqlite3",
      ]);
      expect(`${r.stdout}\n${r.stderr}`).toContain(
        "better-sqlite3 native binding is not loadable",
      );
      expect(r.stdout).not.toContain("DeepSeek Harness install complete");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails DSH installation when the bundled ONNX CPU backend cannot load", () => {
    const fixture = makeDshFixture({
      firstAdd: "success",
      onnxProbe: "error",
    });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");

      const r = run(["--agent", "dsh", "--version", tarball], fixture.env);

      expect(r.code).not.toBe(0);
      expect(readFileSync(fixture.nativeProbeLog, "utf8").trim().split("\n")).toEqual([
        "better-sqlite3",
        "onnxruntime-node",
      ]);
      expect(`${r.stdout}\n${r.stderr}`).toContain(
        "onnxruntime-node CPU binding is not loadable",
      );
      expect(r.stdout).not.toContain("DeepSeek Harness install complete");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("supports the curl-pipe bash stdin invocation for DSH", () => {
    const fixture = makeDshFixture({ firstAdd: "success", pnpm: "missing" });
    try {
      const tarball = path.join(fixture.root, "memos-local-plugin.tgz");
      writeFileSync(tarball, "fixture", "utf8");
      const r = runViaStdin(
        ["--agent", "dsh", "--profile", "web", "--version", tarball],
        fixture.env,
      );

      expect(r.code).toBe(0);
      expect(readFileSync(fixture.log, "utf8")).toContain(
        `plugin --profile web add ${tarball}`,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("generates an OpenClaw manifest that points at compiled runtime output", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain('OPENCLAW_RUNTIME_ENTRY="./dist/adapters/openclaw/index.js"');
    expect(script).toContain('"extensions": ["${OPENCLAW_RUNTIME_ENTRY}"]');
    expect(script).toContain('"contracts": {');
    expect(script).toContain('"memos_search"');
    expect(script).toContain("const MEMOS_TOOL_NAMES = [");
    expect(script).toContain("if (!Array.isArray(config.tools.alsoAllow)) config.tools.alsoAllow = []");
    expect(script).toContain("config.tools.alsoAllow.push(toolName)");
    expect(script).toContain("config.plugins.entries[pluginId].hooks.allowConversationAccess = true");
    expect(script).not.toContain('"extensions": ["./adapters/openclaw/index.ts"]');
  });

  it("publishes package runtime output without docs or tests", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      files?: string[];
      main?: string;
      openclaw?: { extensions?: string[] };
      scripts?: { build?: string };
    };
    expect(pkg.main).toBe("dist/core/index.js");
    expect(pkg.scripts?.build).toContain("scripts/copy-runtime-assets.cjs");
    expect(pkg.openclaw?.extensions).toContain("./dist/adapters/openclaw/index.js");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("viewer/dist");
    expect(pkg.files).not.toContain("viewer");
    expect(pkg.files).not.toContain("ARCHITECTURE.md");
    expect(pkg.files).not.toContain("CHANGELOG.md");
    expect(pkg.files).toContain("!**/ALGORITHMS.md");
    expect(pkg.files).toContain("!**/*.map");
    expect(pkg.files).toContain("!dist/tests/**");
    expect(pkg.files).not.toContain("docs");
    expect(pkg.files).not.toContain("tests");
  });
});
