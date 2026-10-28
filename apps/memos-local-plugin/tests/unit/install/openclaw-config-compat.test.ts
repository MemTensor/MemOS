import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

// Execute the actual embedded patch, including the curl | bash distribution path.
function patch(input: unknown): Record<string, any> {
  const dir = mkdtempSync(path.join(tmpdir(), "memos-openclaw-config-"));
  try {
    const config = path.join(dir, "openclaw.json");
    writeFileSync(config, JSON.stringify(input));
    const script = readFileSync(path.join(root, "install.sh"), "utf8");
    const source = script.match(/  node - <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
    expect(source).toBeDefined();
    const result = spawnSync(process.execPath, ["-e", source!], {
      encoding: "utf8",
      env: { ...process.env, CONFIG_PATH: config, PLUGIN_ID: "memos-local-plugin",
        INSTALL_PATH: path.join(dir, "plugin"), SOURCE_KIND: "path", SOURCE_SPEC: "test.tgz",
        PLUGIN_VERSION: "test", LEGACY_JSON: "memos-local-openclaw-plugin," },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(config, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("OpenClaw installer config compatibility", () => {
  it("installs into current hosts without creating retired install records", () => {
    const result = patch({});
    expect(result.plugins.installs).toBeUndefined();
    expect(result.plugins.slots.memory).toBe("memos-local-plugin");
    expect(result.plugins.allow).toContain("memos-local-plugin");
  });

  it.each([null, [], "invalid", { "memos-local-plugin": { source: "path" } }])(
    "cleans obsolete installer records and malformed legacy values: %j", (installs) => {
      expect(patch({ plugins: { installs } }).plugins.installs).toBeUndefined();
    },
  );

  it("preserves unrelated old-host records and existing hook settings across reinstallation", () => {
    const other = { source: "npm", spec: "another-plugin@1.0.0" };
    const input = { plugins: {
      installs: { "another-plugin": other, "memos-local-plugin": { source: "path" },
        "memos-local-openclaw-plugin": { source: "path" } },
      entries: { "memos-local-plugin": { hooks: { customHostSetting: "keep" } } },
    } };
    const result = patch(input);
    expect(result.plugins.installs).toEqual({ "another-plugin": other });
    expect(result.plugins.entries["memos-local-plugin"].hooks).toEqual({
      customHostSetting: "keep", allowConversationAccess: true,
    });
    expect(patch(result)).toEqual(result);
  });
});
