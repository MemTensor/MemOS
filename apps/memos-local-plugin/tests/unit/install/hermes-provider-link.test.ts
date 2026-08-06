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

  it("PowerShell installer surfaces junction failures instead of swallowing them", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");

    // New-Item -ItemType Junction now runs inside try/catch with -ErrorAction Stop
    expect(source).toContain("-ErrorAction Stop");
    expect(source).toContain("Failed to create junction at $Target");
  });

  it("Unix adapter installer guards HOME and cleans stale symlink targets", () => {
    const source = readFileSync(
      path.join(repoRoot, "adapters/hermes/install.hermes.sh"),
      "utf8",
    );

    expect(source).toContain('${HOME:?HOME must be set');
    expect(source).toContain('if [[ -L "$USER_TARGET" ]]; then rm "$USER_TARGET"');
    expect(source).toContain('LEGACY_TARGET="$HERMES_PLUGINS_DIR/memos_provider"');
  });

  it("main Unix installer uses atomic ln -sfn and prepares provider dir first", () => {
    const source = readFileSync(path.join(repoRoot, "install.sh"), "utf8");

    // cp runs BEFORE the loop now so the provider dir is populated before
    // the second symlink is created.
    const cpPos = source.indexOf('cp "${adapter_dir}/plugin.yaml"');
    const loopPos = source.indexOf("provider_targets=(");
    expect(cpPos).toBeGreaterThan(0);
    expect(loopPos).toBeGreaterThan(cpPos);
    expect(source).toContain('ln -sfn "${adapter_dir}/memos_provider" "${target}"');
  });
});
