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
    [string]$PluginId
  )

  Write-Info "Updating OpenClaw config..."
  New-Item -ItemType Directory -Path $OpenClawHome -Force | Out-Null
  $nodeScript = @'
const fs = require("fs");

const configPath = process.argv[2];
const pluginId = process.argv[3];

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

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
'@
  $nodeScript | & node - $ConfigPath $PluginId
  Write-Success "OpenClaw config updated: $ConfigPath"
}

function Ensure-PluginDirRemovedByUninstall {
  param([string]$ExtensionDir, [string]$PluginId)

  $preservedDistPath = ""
  if (Test-Path $ExtensionDir) {
    Write-Warn "Plugin directory still exists after uninstall: $ExtensionDir"
    Write-Warn "Preparing plugin directory for reinstall while preserving dist..."

    $distPath = Join-Path $ExtensionDir "dist"
    if (Test-Path $distPath) {
      $backupRoot = Join-Path $env:TEMP ("memos-local-openclaw-dist-" + [guid]::NewGuid().ToString("N"))
      New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
      $preservedDistPath = Join-Path $backupRoot "dist"
      try {
        Move-Item -LiteralPath $distPath -Destination $preservedDistPath -Force -ErrorAction Stop
        Write-Info "Preserved dist for reinstall: $preservedDistPath"
      }
      catch {
        Write-Err "Failed to preserve dist directory before cleanup."
        Write-Err $_.Exception.Message
        exit 1
      }
    }

    $items = Get-ChildItem -LiteralPath $ExtensionDir -Force -ErrorAction SilentlyContinue
    foreach ($item in $items) {
      try {
        Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
      }
      catch {
        Write-Err "Failed to remove leftover item: $($item.FullName)"
        Write-Err $_.Exception.Message
        exit 1
      }
    }

    $remaining = Get-ChildItem -LiteralPath $ExtensionDir -Force -ErrorAction SilentlyContinue
    $nonDistRemaining = @($remaining | Where-Object { $_.Name -ine "dist" })
    if ($nonDistRemaining.Count -gt 0) {
      Write-Err "Leftover files still exist after cleanup."
      $nonDistRemaining | ForEach-Object { Write-Host $_.FullName }
      exit 1
    }

    try {
      Remove-Item -LiteralPath $ExtensionDir -Recurse -Force -ErrorAction Stop
    }
    catch {
      Write-Err "Failed to remove plugin directory before reinstall: $ExtensionDir"
      Write-Err $_.Exception.Message
      exit 1
    }

    if (Test-Path $ExtensionDir) {
      Write-Err "Plugin directory still exists before reinstall: $ExtensionDir"
      exit 1
    }

    Write-Success "Plugin directory prepared for reinstall."
  }

  return $preservedDistPath
}

function Restore-PreservedDistIfNeeded {
  param([string]$PreservedDistPath, [string]$ExtensionDir)
  if ([string]::IsNullOrWhiteSpace($PreservedDistPath) -or -not (Test-Path $PreservedDistPath)) {
    return
  }

  $targetDistPath = Join-Path $ExtensionDir "dist"
  $backupRoot = Split-Path -Path $PreservedDistPath -Parent
  try {
    if (Test-Path $targetDistPath) {
      $legacyDistPath = Join-Path $ExtensionDir ("dist_preserved_" + (Get-Date -Format "yyyyMMddHHmmss"))
      Move-Item -LiteralPath $PreservedDistPath -Destination $legacyDistPath -Force -ErrorAction Stop
      Write-Warn "Installer created a new dist. Previous dist was preserved at: $legacyDistPath"
    }
    else {
      Move-Item -LiteralPath $PreservedDistPath -Destination $targetDistPath -Force -ErrorAction Stop
      Write-Success "Restored preserved dist to: $targetDistPath"
    }
  }
  catch {
    Write-Err "Failed to restore preserved dist."
    Write-Err $_.Exception.Message
    exit 1
  }
  finally {
    if (Test-Path $backupRoot) {
      Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Uninstall-PluginIfPresent {
  param([string]$PluginId)

  $outputLines = @()
  try {
    $outputLines = "y`n" | & npx openclaw plugins uninstall $PluginId 2>&1
  }
  catch {
    $outputLines += ($_ | Out-String)
  }

  $outputText = ($outputLines | Out-String)
  if (-not [string]::IsNullOrWhiteSpace($outputText) -and ($outputText -notmatch "Plugin not found")) {
    Write-Warn "Uninstall returned messages and will be ignored to match install.sh behavior."
  }
  Write-Info "Uninstall step completed (best effort)."
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

Write-Info "Uninstalling existing plugin if present..."
Uninstall-PluginIfPresent -PluginId $PluginId
$preservedDistPath = Ensure-PluginDirRemovedByUninstall -ExtensionDir $ExtensionDir -PluginId $PluginId

Write-Info "Installing plugin $PackageSpec..."
& npx openclaw plugins install $PackageSpec

if (-not (Test-Path $ExtensionDir)) {
  Write-Err "Plugin directory was not found: $ExtensionDir"
  exit 1
}

Restore-PreservedDistIfNeeded -PreservedDistPath $preservedDistPath -ExtensionDir $ExtensionDir

Write-Info "Rebuilding better-sqlite3..."
Push-Location $ExtensionDir
try {
  & npm rebuild better-sqlite3
}
finally {
  Pop-Location
}

Update-OpenClawConfig -OpenClawHome $OpenClawHome -ConfigPath $OpenClawConfigPath -PluginId $PluginId

Write-Success "Restarting OpenClaw Gateway..."
& npx openclaw gateway run --port $Port --force
