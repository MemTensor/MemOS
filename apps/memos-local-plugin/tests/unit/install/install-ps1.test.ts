import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "install.ps1");

function extractOpenClawConfigPatch(script: string): string {
  const match = script.match(/\$NodeScript = @"\r?\n([\s\S]*?)\r?\n"@\r?\n/);
  if (!match?.[1]) throw new Error("OpenClaw config patch script not found");
  return match[1];
}

function extractFunction(script: string, name: string, nextName: string): string {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start);
  if (start < 0 || end < 0) throw new Error(`${name} function not found`);
  return script.slice(start, end);
}

describe("install.ps1 — gateway recovery", () => {
  it("restarts OpenClaw from finally when installation fails after stop", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const installOpenClaw = extractFunction(
      script,
      "Install-OpenClaw",
      "Install-Hermes",
    );

    expect(installOpenClaw).toMatch(
      /Invoke-OpenClawGatewayChecked\s+-Action\s+"stop"[\s\S]*\$GatewayRecoveryState\s*=\s*"needs_recovery"/,
    );
    expect(installOpenClaw).toMatch(
      /finally\s*\{[\s\S]*\$GatewayRecoveryState\s+-eq\s+"needs_recovery"[\s\S]*Invoke-OpenClawGatewayChecked\s+-Action\s+"start"/,
    );
  });

  it("checks native gateway failures and does not retry a failed final start", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const installOpenClaw = extractFunction(
      script,
      "Install-OpenClaw",
      "Install-Hermes",
    );
    const invokeGateway = extractFunction(
      script,
      "Invoke-OpenClawGatewayChecked",
      "Test-BetterSqlite3",
    );

    expect(invokeGateway).toContain("$ExitCode = $LASTEXITCODE");
    expect(invokeGateway).toMatch(/if \(\$ExitCode -ne 0\)[\s\S]*throw/);
    expect(installOpenClaw).toMatch(
      /catch\s*\{[\s\S]*\$GatewayRecoveryState\s*=\s*"final_failed"[\s\S]*throw/,
    );
  });

  it("cleans the installer staging directory from a top-level finally block", () => {
    const script = readFileSync(SCRIPT, "utf8");

    expect(script).toMatch(
      /\}\s*finally\s*\{\s*if \(\$StageDir -and \(Test-Path \$StageDir\)\) \{\s*Remove-Item[^\n]*\$StageDir[\s\S]*\}\s*\}\s*$/,
    );
  });
});

describe("install.ps1 — OpenClaw config patch", () => {
  it("preserves existing hook settings and enables conversation access", () => {
    const script = readFileSync(SCRIPT, "utf8");

    expect(script).toContain(
      "typeof config.plugins.entries[pluginId].hooks !== 'object'",
    );
    expect(script).toContain("Array.isArray(config.plugins.entries[pluginId].hooks)");
    expect(script).toContain("config.plugins.entries[pluginId].hooks = {};");
    expect(script).toContain(
      "config.plugins.entries[pluginId].hooks.allowConversationAccess = true;",
    );
    expect(script).not.toContain(
      "delete config.plugins.entries[pluginId].hooks",
    );
  });

  it("keeps unrelated existing hook fields when patching openclaw.json", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "memos-install-ps1-"));
    const configPath = path.join(tempDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            "memos-local-plugin": {
              hooks: { customHostSetting: "keep", allowConversationAccess: false },
            },
          },
        },
      }),
    );

    try {
      const result = spawnSync(
        process.execPath,
        ["-e", extractOpenClawConfigPatch(readFileSync(SCRIPT, "utf8"))],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CONFIG_PATH: configPath,
            PLUGIN_ID: "memos-local-plugin",
            INSTALL_PATH: path.join(tempDir, "plugin"),
            SOURCE_KIND: "path",
            SOURCE_SPEC: "local.tgz",
            PLUGIN_VERSION: "test-version",
            LEGACY_JSON: "memos-local-openclaw-plugin",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);

      const patched = JSON.parse(readFileSync(configPath, "utf8")) as {
        plugins: {
          entries: Record<string, { hooks: Record<string, unknown> }>;
          installs?: Record<string, unknown>;
        };
      };
      expect(patched.plugins.entries["memos-local-plugin"].hooks).toEqual({
        customHostSetting: "keep",
        allowConversationAccess: true,
      });
      expect(patched.plugins.installs).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("removes only MemOS legacy install records and preserves unrelated old-version records", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "memos-install-ps1-"));
    const configPath = path.join(tempDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          installs: {
            "memos-local-plugin": { source: "path", installPath: "old-memos" },
            "memos-local-openclaw-plugin": {
              source: "path",
              installPath: "legacy-memos",
            },
            "another-plugin": { source: "npm", spec: "another-plugin@1.0.0" },
          },
        },
      }),
    );

    try {
      const result = spawnSync(
        process.execPath,
        ["-e", extractOpenClawConfigPatch(readFileSync(SCRIPT, "utf8"))],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CONFIG_PATH: configPath,
            PLUGIN_ID: "memos-local-plugin",
            INSTALL_PATH: path.join(tempDir, "plugin"),
            SOURCE_KIND: "path",
            SOURCE_SPEC: "local.tgz",
            PLUGIN_VERSION: "test-version",
            LEGACY_JSON: "memos-local-openclaw-plugin",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);

      const patched = JSON.parse(readFileSync(configPath, "utf8")) as {
        plugins: { installs?: Record<string, unknown> };
      };
      expect(patched.plugins.installs).toEqual({
        "another-plugin": { source: "npm", spec: "another-plugin@1.0.0" },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

const PWSH_AVAILABLE = (() => {
  const probe = spawnSync(
    process.platform === "win32" ? "pwsh" : "pwsh",
    ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { encoding: "utf8", timeout: 30_000 },
  );
  return probe.status === 0;
})();

function extractPsFunction(script: string, name: string, nextName: string): string {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start);
  if (start < 0 || end < 0) throw new Error(`${name} function not found`);
  return script.slice(start, end);
}

function runResetOversizedLog(harness: string): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const script = readFileSync(SCRIPT, "utf8");
  const writeWarn = script.match(/function Write-Warn.*?\n/)?.[0] ?? "";
  const resetLog = extractPsFunction(script, "Reset-OversizedLog", "Wait-ForViewer");
  const r = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", `${writeWarn}\n${resetLog}\n${harness}`],
    { encoding: "utf8", timeout: 60_000 },
  );
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!PWSH_AVAILABLE)("install.ps1 — Reset-OversizedLog", () => {
  it("does nothing when the log file is absent", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "memos-reset-log-"));
    try {
      const logPath = path.join(tempDir, "daemon.log");
      const r = runResetOversizedLog(`Reset-OversizedLog -Path "${logPath}"`);
      expect(r.code).toBe(0);
      expect(existsSync(logPath)).toBe(false);
      expect(existsSync(`${logPath}.1`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not rotate when the size exactly equals the cap", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "memos-reset-log-"));
    try {
      const logPath = path.join(tempDir, "daemon.log");
      writeFileSync(logPath, Buffer.alloc(2048, "a"), "utf8");
      const r = runResetOversizedLog(
        `Reset-OversizedLog -Path "${logPath}" -MaxBytes 2048`,
      );
      expect(r.code).toBe(0);
      expect(readFileSync(logPath, "utf8")).toHaveLength(2048);
      expect(existsSync(`${logPath}.1`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rotates an over-cap log, trims .1 to the cap, and removes a stale .1", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "memos-reset-log-"));
    try {
      const logPath = path.join(tempDir, "daemon.log");
      writeFileSync(logPath, Buffer.alloc(6000, "a"), "utf8");
      writeFileSync(`${logPath}.1`, "stale-generation", "utf8");
      const r = runResetOversizedLog(
        `Reset-OversizedLog -Path "${logPath}" -MaxBytes 1024`,
      );
      expect(r.code).toBe(0);
      // Active log truncated, ready for the launch redirect.
      expect(readFileSync(logPath, "utf8")).toHaveLength(0);
      // `.1` keeps only the tail, bounded at the cap (not the full 6000 B).
      expect(readFileSync(`${logPath}.1`, "utf8")).toHaveLength(1024);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
