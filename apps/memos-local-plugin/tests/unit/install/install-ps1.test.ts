import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
