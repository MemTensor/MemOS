$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$env:NPM_CONFIG_LOGLEVEL = "error"

function Write-Info {
  param([string]$Message)
  Write-Host $Message -ForegroundColor Cyan
}

function Write-Success {
  param([string]$Message)
  Write-Host $Message -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host $Message -ForegroundColor Yellow
}

function Write-Err {
  param([string]$Message)
  Write-Host $Message -ForegroundColor Red
}

function Get-NodeMajorVersion {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    return 0
  }
  $versionRaw = & node -v 2>$null
  if (-not $versionRaw) {
    return 0
  }
  $trimmed = $versionRaw.TrimStart("v")
  $majorText = $trimmed.Split(".")[0]
  $major = 0
  if ([int]::TryParse($majorText, [ref]$major)) {
    return $major
  }
  return 0
}

function Update-SessionPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Install-Node {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Err "winget is required for automatic Node.js installation on Windows."
    Write-Err "Install Node.js 22 or newer manually from https://nodejs.org and rerun this script."
    exit 1
  }

  Write-Info "Installing Node.js via winget..."
  & winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements --silent
  Update-SessionPath
}

function Ensure-Node22 {
  $requiredMajor = 22
  $currentMajor = Get-NodeMajorVersion
  if ($currentMajor -ge $requiredMajor) {
    Write-Success "Node.js version check passed (>= $requiredMajor)."
    return
  }

  Write-Warn "Node.js >= $requiredMajor is required."
  Write-Warn "Node.js is missing or too old. Starting automatic installation..."
  Install-Node

  $currentMajor = Get-NodeMajorVersion
  if ($currentMajor -ge $requiredMajor) {
    $currentVersion = & node -v
    Write-Success "Node.js is ready: $currentVersion"
    return
  }

  Write-Err "Node.js installation did not meet version >= $requiredMajor."
  exit 1
}

function Print-Banner {
  Write-Host "Memos Local OpenClaw Installer" -ForegroundColor Cyan
  Write-Host "Memos Local Memory for OpenClaw." -ForegroundColor Cyan
  Write-Host "Keep your context, tasks, and recall in one local memory engine." -ForegroundColor Yellow
}

function Parse-Arguments {
  param([string[]]$RawArgs)

  $result = @{
    PluginVersion = "latest"
    Port = "18789"
    OpenClawHome = (Join-Path $HOME ".openclaw")
  }

  $index = 0
  while ($index -lt $RawArgs.Count) {
    $arg = $RawArgs[$index]
    switch ($arg) {
      "--version" {
        if ($index + 1 -ge $RawArgs.Count) {
          Write-Err "Missing value for --version."
          exit 1
        }
        $result.PluginVersion = $RawArgs[$index + 1]
        $index += 2
      }
      "--port" {
        if ($index + 1 -ge $RawArgs.Count) {
          Write-Err "Missing value for --port."
          exit 1
        }
        $result.Port = $RawArgs[$index + 1]
        $index += 2
      }
      "--openclaw-home" {
        if ($index + 1 -ge $RawArgs.Count) {
          Write-Err "Missing value for --openclaw-home."
          exit 1
        }
        $result.OpenClawHome = $RawArgs[$index + 1]
        $index += 2
      }
      default {
        Write-Err "Unknown argument: $arg"
        Write-Warn "Usage: .\apps\install.ps1 [--version <version>] [--port <port>] [--openclaw-home <path>]"
        exit 1
      }
    }
  }

  if ([string]::IsNullOrWhiteSpace($result.PluginVersion) -or
      [string]::IsNullOrWhiteSpace($result.Port) -or
      [string]::IsNullOrWhiteSpace($result.OpenClawHome)) {
    Write-Err "Arguments cannot be empty."
    exit 1
  }

  return $result
}

function Update-OpenClawConfig {
  param(
    [string]$OpenClawHome,
    [string]$ConfigPath,
    [string]$PluginId,
    [string]$InstallPath,
    [string]$Spec
  )

  Write-Info "Updating OpenClaw config..."
  New-Item -ItemType Directory -Path $OpenClawHome -Force | Out-Null
  $nodeScript = @'
const fs = require("fs");
const path = require("path");

const configPath = process.argv[2];
const pluginId = process.argv[3];
const installPath = process.argv[4];
const spec = process.argv[5];

let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8").trim();
  if (raw.length > 0) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed;
    }
  }
}

if (!config.plugins || typeof config.plugins !== "object" || Array.isArray(config.plugins)) {
  config.plugins = {};
}

config.plugins.enabled = true;

if (!Array.isArray(config.plugins.allow)) {
  config.plugins.allow = [];
}

if (!config.plugins.allow.includes(pluginId)) {
  config.plugins.allow.push(pluginId);
}

// Clean up stale contextEngine slot from previous versions
if (config.plugins.slots && config.plugins.slots.contextEngine) {
  delete config.plugins.slots.contextEngine;
  if (Object.keys(config.plugins.slots).length === 0) {
    delete config.plugins.slots;
  }
}

// Register plugin in memory slot
if (!config.plugins.slots || typeof config.plugins.slots !== "object") {
  config.plugins.slots = {};
}
config.plugins.slots.memory = pluginId;

// Ensure plugin entry is enabled (preserve existing config if present)
if (!config.plugins.entries || typeof config.plugins.entries !== "object") {
  config.plugins.entries = {};
}
if (!config.plugins.entries[pluginId] || typeof config.plugins.entries[pluginId] !== "object") {
  config.plugins.entries[pluginId] = {};
}
config.plugins.entries[pluginId].enabled = true;

// Register plugin in installs so gateway auto-loads it on restart (pinned spec when package.json exists)
if (!config.plugins.installs || typeof config.plugins.installs !== "object") {
  config.plugins.installs = {};
}
let resolvedName = "";
let resolvedVersion = "";
const pkgJsonPath = path.join(installPath, "package.json");
if (fs.existsSync(pkgJsonPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  resolvedName = pkg.name;
  resolvedVersion = pkg.version;
}
const pinnedSpec = resolvedName && resolvedVersion ? `${resolvedName}@${resolvedVersion}` : spec;
config.plugins.installs[pluginId] = {
  source: "npm",
  spec: pinnedSpec,
  installPath,
  ...(resolvedVersion ? { version: resolvedVersion } : {}),
  ...(resolvedName ? { resolvedName } : {}),
  ...(resolvedVersion ? { resolvedVersion } : {}),
  ...(resolvedName && resolvedVersion ? { resolvedSpec: pinnedSpec } : {}),
  installedAt: new Date().toISOString(),
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
'@
  $nodeScript | & node - $ConfigPath $PluginId $InstallPath $Spec
  Write-Success "OpenClaw config updated: $ConfigPath"
}


$parsed = Parse-Arguments -RawArgs $args
$PluginVersion = $parsed.PluginVersion
$Port = $parsed.Port
$OpenClawHome = $parsed.OpenClawHome

$PluginId = "memos-local-openclaw-plugin"
$PluginPackage = "@memtensor/memos-local-openclaw-plugin"
$PackageSpec = "$PluginPackage@$PluginVersion"
$ExtensionDir = Join-Path $OpenClawHome "extensions\$PluginId"
$OpenClawConfigPath = Join-Path $OpenClawHome "openclaw.json"

Print-Banner
Ensure-Node22

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Err "npx was not found after Node.js setup."
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Err "npm was not found after Node.js setup."
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Err "node was not found after setup."
  exit 1
}

Write-Info "Stopping OpenClaw Gateway..."
try {
  & npx openclaw gateway stop *> $null
}
catch {
  Write-Warn "OpenClaw gateway stop returned an error. Continuing..."
}

$portNumber = 0
if ([int]::TryParse($Port, [ref]$portNumber)) {
  $connections = Get-NetTCPConnection -LocalPort $portNumber -ErrorAction SilentlyContinue
  if ($connections) {
    $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    if ($pids) {
      Write-Warn "Processes still using port $Port. Killing PID(s): $($pids -join ', ')"
      foreach ($processId in $pids) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

Write-Info "Removing old plugin directory if exists..."
if (Test-Path $ExtensionDir) {
  Remove-Item -LiteralPath $ExtensionDir -Recurse -Force -ErrorAction Stop
  Write-Success "Old plugin directory removed."
}

Write-Info "Installing plugin $PackageSpec (direct npm)..."
$TmpPackDir = Join-Path $env:TEMP ("memos-pack-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TmpPackDir -Force | Out-Null

try {
  if (Test-Path $PluginVersion) {
    Write-Info "Using local tarball: $PluginVersion"
    Copy-Item -LiteralPath $PluginVersion -Destination (Join-Path $TmpPackDir "plugin.tgz") -Force
  }
  else {
    Write-Info "Downloading package from npm..."
    & npm pack $PackageSpec --pack-destination $TmpPackDir 2>$null
    $tarball = Get-ChildItem -Path $TmpPackDir -Filter "*.tgz" | Select-Object -First 1
    if (-not $tarball) {
      Write-Err "Failed to download package: $PackageSpec"
      exit 1
    }
    Rename-Item -LiteralPath $tarball.FullName -NewName "plugin.tgz"
  }

  New-Item -ItemType Directory -Path $ExtensionDir -Force | Out-Null
  & tar xzf (Join-Path $TmpPackDir "plugin.tgz") -C $ExtensionDir --strip-components=1

  if (-not (Test-Path (Join-Path $ExtensionDir "package.json"))) {
    Write-Err "Plugin extraction failed - package.json not found."
    exit 1
  }
}
finally {
  if (Test-Path $TmpPackDir) {
    Remove-Item -LiteralPath $TmpPackDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Info "Installing dependencies..."
Push-Location $ExtensionDir
try {
  $env:MEMOS_SKIP_SETUP = "1"
  & npm install --omit=dev --no-fund --no-audit --loglevel=error 2>&1
}
finally {
  Remove-Item Env:\MEMOS_SKIP_SETUP -ErrorAction SilentlyContinue
  Pop-Location
}

$nodeModulesDir = Join-Path $ExtensionDir "node_modules"
if (-not (Test-Path $nodeModulesDir) -or @(Get-ChildItem -Path $nodeModulesDir -ErrorAction SilentlyContinue).Count -eq 0) {
  Write-Warn "node_modules was cleaned by postinstall (version upgrade detected), re-installing..."
  Push-Location $ExtensionDir
  try {
    $env:MEMOS_SKIP_SETUP = "1"
    & npm install --omit=dev --no-fund --no-audit --loglevel=error 2>&1
  }
  finally {
    Remove-Item Env:\MEMOS_SKIP_SETUP -ErrorAction SilentlyContinue
    Pop-Location
  }
}

if (-not (Test-Path $ExtensionDir)) {
  Write-Err "Plugin directory not found after install: $ExtensionDir"
  exit 1
}

$NodeModulesDir = Join-Path $ExtensionDir "node_modules"
if (-not (Test-Path $NodeModulesDir)) {
  Write-Warn "node_modules missing after install (postinstall may have cleaned it). Reinstalling..."
  Push-Location $ExtensionDir
  try {
    & npm install --omit=dev --no-fund --no-audit --ignore-scripts --loglevel=error 2>&1
  }
  finally {
    Pop-Location
  }
}

$SqliteDir = Join-Path $ExtensionDir "node_modules\better-sqlite3"
if (-not (Test-Path $SqliteDir)) {
  Write-Warn "better-sqlite3 missing, attempting rebuild..."
  Push-Location $ExtensionDir
  try {
    & npm rebuild better-sqlite3 2>&1
  }
  catch {
    Write-Warn "better-sqlite3 rebuild returned an error. Continuing..."
  }
  finally {
    Pop-Location
  }
}

if (-not (Test-Path $NodeModulesDir)) {
  Write-Err "Dependencies installation failed. Run manually: cd $ExtensionDir && npm install --omit=dev"
  exit 1
}

Update-OpenClawConfig -OpenClawHome $OpenClawHome -ConfigPath $OpenClawConfigPath -PluginId $PluginId -InstallPath $ExtensionDir -Spec $PackageSpec

Write-Info "Installing OpenClaw Gateway service..."
& npx openclaw gateway install --port $Port --force 2>&1
if (-not $?) { Write-Warn "Gateway service install returned a warning; continuing..." }

Write-Success "Starting OpenClaw Gateway service..."
& npx openclaw gateway start 2>&1

Write-Info "Starting Memory Viewer, 正在启动记忆面板..."
for ($i = 1; $i -le 5; $i++) {
  $listening = Get-NetTCPConnection -LocalPort 18799 -State Listen -ErrorAction SilentlyContinue
  if ($listening) { break }
  Write-Host "." -NoNewline
  Start-Sleep -Seconds 1
}
Write-Host ""

Write-Host ""
Write-Success "=========================================="
Write-Success "  Installation complete! 安装完成!"
Write-Success "=========================================="
Write-Host ""
Write-Info "  OpenClaw Web UI:      http://localhost:$Port"
Write-Info "  Memory Viewer:        http://localhost:18799"
Write-Host ""
