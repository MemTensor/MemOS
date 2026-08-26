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

    expect(source).toContain('$UserPluginDir = Join-Path $HermesHome "plugins\\memory"');
    expect(source).toContain('(Join-Path $PluginDir "memtensor")');
    expect(source).toContain('(Join-Path $UserPluginDir "memtensor")');
  });

  it("PowerShell installer resolves Hermes host data from HERMES_HOME", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");

    expect(source).toContain("function Resolve-HermesHostHome");
    expect(source).toContain('$ConfiguredHome = $env:HERMES_HOME');
    expect(source).toContain("[Environment]::ExpandEnvironmentVariables");
    expect(source).toContain("[IO.Path]::IsPathRooted");
    expect(source).toContain('$HermesHome = Resolve-HermesHostHome');
    expect(source).toContain('$env:HERMES_HOME = $HermesHome');
    expect(source).toContain('$HasHermes = Test-Path $HermesHome');
    expect(source).toContain('$ConfigFile = Join-Path $HermesHome "config.yaml"');
    expect(source).toContain('$UserPluginDir = Join-Path $HermesHome "plugins\\memory"');
    expect(source).not.toContain('$ConfigFile = Join-Path $env:LOCALAPPDATA "hermes\\config.yaml"');
    expect(source).not.toContain('$UserPluginDir = Join-Path $env:LOCALAPPDATA "hermes\\plugins\\memory"');
  });

  it("PowerShell installer keeps code and MemOS package paths under LocalAppData", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");

    expect(source).toContain('$Prefix = Join-Path $env:LOCALAPPDATA "hermes\\memos-plugin"');
    expect(source).toContain(
      '$VenvPy = Join-Path $env:LOCALAPPDATA "hermes\\hermes-agent\\venv\\Scripts\\python.exe"',
    );
    expect(source).toContain(
      '$DefaultPluginDir = Join-Path $env:LOCALAPPDATA "hermes\\hermes-agent\\plugins\\memory"',
    );
  });

  it("PowerShell installer surfaces junction failures instead of swallowing them", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");

    // New-Item -ItemType Junction now runs inside try/catch with -ErrorAction Stop
    expect(source).toContain("-ErrorAction Stop");
    expect(source).toContain("Failed to create junction at $Target");
  });

  it("PowerShell installer preserves and explicitly passes the selected runtime home", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");

    expect(source).toContain(".memos-runtime-home");
    expect(source).toContain(".hermes\\memos-plugin");
    expect(source).toContain("both Windows Hermes runtime homes contain a database");
    expect(source).toContain('--home=`"$HomeDir`"');
    expect(source).toContain('".migrations"');
    expect(source).toContain('Source = "environment"; Persist = $true');

    const unixSource = readFileSync(path.join(repoRoot, "install.sh"), "utf8");
    expect(unixSource).toContain("daemon .migrations config.yaml");
  });

  it("PowerShell installer stages dependencies and fails closed on native command errors", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");

    expect(source).toContain("function Invoke-NativeChecked");
    expect(source).toContain("function Test-BetterSqlite3");
    expect(source).toContain("function Prepare-StagedPackage");
    expect(source).toContain("Get-CimInstance Win32_Process");
    expect(source).toMatch(/bridge\\\.\(cts\|cjs\|mts\|mjs\)/);
    expect(source).toContain("npm install failed");
    expect(source).toContain("better-sqlite3 is not loadable");

    const preserveLine = source.split("\n").find((line) => line.includes("$Preserve = @("));
    expect(preserveLine).toBeDefined();
    expect(preserveLine).not.toContain('"node_modules"');
  });

  it("legacy agent installers omit DSH peers without resolving their development peer tree", () => {
    const unixSource = readFileSync(path.join(repoRoot, "install.sh"), "utf8");
    const windowsSource = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");

    expect(unixSource).toContain("npm install --omit=dev --legacy-peer-deps");
    expect(windowsSource).toMatch(
      /"install", "--omit=dev", "--legacy-peer-deps", "--no-fund"/,
    );
  });

  it("PowerShell installer stops Hermes only after staging succeeds", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");
    const deployStart = source.indexOf("function Deploy-Tarball");
    const deployEnd = source.indexOf("function Prepare-StagedPackage");
    const deploySource = source.slice(deployStart, deployEnd);
    const preparePos = deploySource.indexOf("Prepare-StagedPackage");
    const handoffPos = deploySource.indexOf("& $BeforeSwap");

    expect(preparePos).toBeGreaterThan(0);
    expect(handoffPos).toBeGreaterThan(preparePos);

    const hermesStart = source.indexOf("function Install-Hermes");
    const hermesEnd = source.indexOf("if ($AgentSelection", hermesStart);
    const hermesSource = source.slice(hermesStart, hermesEnd);
    const deployPos = hermesSource.indexOf("Deploy-Tarball");
    const stopHermesPos = hermesSource.indexOf('Get-Process -Name "hermes"');

    expect(deployPos).toBeGreaterThan(0);
    expect(stopHermesPos).toBeGreaterThan(deployPos);
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
