import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

describe("Hermes provider install links", () => {
  it("main Unix installer links both checkout-local and user-level provider paths", () => {
    const source = readFileSync(path.join(repoRoot, "install.sh"), "utf8");

    expect(source).toContain('${HOME}/.hermes/plugins/memory');
    expect(source).toContain('"${plugin_dir}/memtensor"');
    expect(source).toContain('"${user_plugin_dir}/memtensor"');
  });

  it("adapter Unix installer keeps a user-level provider link", () => {
    const source = readFileSync(
      path.join(repoRoot, "adapters/hermes/install.hermes.sh"),
      "utf8",
    );

    expect(source).toContain('USER_HERMES_PLUGINS_DIR="${HOME}/.hermes/plugins/memory"');
    expect(source).toContain('$USER_HERMES_PLUGINS_DIR/memtensor');
  });

  it("PowerShell installer links both checkout-local and user-level provider paths", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");

    expect(source).toContain('hermes\\plugins\\memory');
    expect(source).toContain('(Join-Path $PluginDir "memtensor")');
    expect(source).toContain('(Join-Path $UserPluginDir "memtensor")');
  });
});
