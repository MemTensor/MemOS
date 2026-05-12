<#
.SYNOPSIS
    install.ps1 — Windows installer for @memtensor/memos-local-plugin.

.DESCRIPTION
    Replicates the functionality of install.sh for Windows environments.
    - Downloads/extracts the tarball
    - Configures OpenClaw and/or Hermes
    - Patches configuration files
    - Restarts services

.PARAMETER Version
    Specific npm version or local path to a .tgz tarball.
#>

[CmdletBinding()]
param(
  [string]$Version,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host "Usage:"
    Write-Host "  .\install.ps1                     # latest from npm"
    Write-Host "  .\install.ps1 -Version X.Y.Z      # specific npm version"
    Write-Host "  .\install.ps1 -Version .\pkg.tgz  # local tarball"
    exit 0
}

# --- Helpers ---
function Write-Info($msg)    { Write-Host "  > $msg" -ForegroundColor Cyan }
function Write-Success($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Stop-Die($msg)      { Write-Host "  [ERROR] $msg" -ForegroundColor Red; exit 1 }

$PluginId = "memos-local-plugin"
$NpmPackage = "@memtensor/memos-local-plugin"
$OpenClawPort = 18799
$HermesPort = 18800
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Blue
Write-Host "     MemOS Local Plugin Installer (Windows)         " -ForegroundColor Blue
Write-Host "  ==================================================" -ForegroundColor Blue
Write-Host ""

# Node check
try {
    $NodeVersionStr = (node -v 2>$null)
    if (-not $NodeVersionStr) { Stop-Die "Node.js is not installed or not in PATH." }
    Write-Success "Node.js $NodeVersionStr"
} catch {
    Stop-Die "Node.js is not installed or not in PATH."
}

# Agent detection
$HasOpenClaw = Test-Path "$env:USERPROFILE\.openclaw"
$HasHermes = Test-Path "$env:LOCALAPPDATA\hermes"

Write-Host "`n  Detected agents:" -ForegroundColor White
if ($HasOpenClaw) { Write-Host "    - OpenClaw   (~/.openclaw)" -ForegroundColor Green }
else { Write-Host "    - OpenClaw   (not installed)" -ForegroundColor DarkGray }

if ($HasHermes) { Write-Host "    - Hermes     (~/AppData/Local/hermes)" -ForegroundColor Green }
else { Write-Host "    - Hermes     (not installed)" -ForegroundColor DarkGray }

Write-Host "`n  Install into which agent?"
Write-Host "    [Enter]  Auto-detect"
Write-Host "    [1]      OpenClaw only"
Write-Host "    [2]      Hermes only"
Write-Host "    [3]      Both"
Write-Host "    [q]      Quit`n"

$Choice = Read-Host "  Choice"
$AgentSelection = "auto"

switch ($Choice) {
    "1" { $AgentSelection = "openclaw" }
    "2" { $AgentSelection = "hermes" }
    "3" { $AgentSelection = "all" }
    "q" { Write-Info "Aborted."; exit 0 }
    "Q" { Write-Info "Aborted."; exit 0 }
    ""  { $AgentSelection = "auto" }
    default { Stop-Die "Invalid choice: $Choice" }
}

if ($AgentSelection -eq "auto") {
    if (-not $HasOpenClaw -and -not $HasHermes) { Stop-Die "Neither ~/.openclaw nor ~/AppData/Local/hermes exists. Install one first." }
    if ($HasOpenClaw -and $HasHermes) { $AgentSelection = "all" }
    elseif ($HasOpenClaw) { $AgentSelection = "openclaw" }
    else { $AgentSelection = "hermes" }
    Write-Success "Auto-detected: $AgentSelection"
}

# Resolve tarball
$StageDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString())) -Force
$SourceKind = "npm"
$SourceSpec = $NpmPackage
$BuiltTarball = ""

if ($Version) {
    if (Test-Path $Version) {
        $SourceKind = "path"
        $BuiltTarball = Resolve-Path $Version | Select-Object -ExpandProperty Path
        $SourceSpec = $BuiltTarball
        Write-Success "Using local tarball: $BuiltTarball"
    } else {
        $SourceSpec = "$NpmPackage@$Version"
        Write-Info "Downloading $SourceSpec from npm..."
    }
} else {
    Write-Info "Downloading latest $NpmPackage from npm..."
}

if (-not $BuiltTarball) {
    Push-Location $StageDir
    try {
        cmd /c "npm pack $SourceSpec --loglevel=error"
        $BuiltTarball = (Get-ChildItem -Filter *.tgz | Select-Object -First 1).FullName
    } finally {
        Pop-Location
    }
    if (-not $BuiltTarball) { Stop-Die "npm pack failed for $SourceSpec." }
    Write-Success "Package downloaded: $(Split-Path $BuiltTarball -Leaf)"
}

function Deploy-Tarball {
    param([string]$Prefix)
    Write-Info "Deploying to $Prefix"
    
    $Preserve = @("node_modules", "data", "logs", "skills", "daemon", "config.yaml", ".auth.json")
    
    if (Test-Path $Prefix) {
        $SavedDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString())) -Force
        foreach ($Item in $Preserve) {
            $Src = Join-Path $Prefix $Item
            if (Test-Path $Src) {
                $Dst = Join-Path $SavedDir $Item
                New-Item -ItemType Directory -Force -Path (Split-Path $Dst -Parent) -ErrorAction SilentlyContinue | Out-Null
                Move-Item -Path $Src -Destination $Dst -Force
            }
        }
        Remove-Item -Recurse -Force $Prefix -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
        
        tar xzf $BuiltTarball -C $Prefix --strip-components=1
        
        foreach ($Item in $Preserve) {
            $SavedItem = Join-Path $SavedDir $Item
            if (Test-Path $SavedItem) {
                $Dst = Join-Path $Prefix $Item
                if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
                Move-Item -Path $SavedItem -Destination $Dst -Force
            }
        }
        Remove-Item -Recurse -Force $SavedDir -ErrorAction SilentlyContinue
    } else {
        New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
        tar xzf $BuiltTarball -C $Prefix --strip-components=1
    }
    
    if (-not (Test-Path (Join-Path $Prefix "package.json"))) { Stop-Die "Extraction failed" }
    Write-Success "Package extracted"
    
    Write-Info "Installing npm dependencies"
    Push-Location $Prefix
    try {
        $env:MEMOS_SKIP_SETUP = "1"
        cmd /c "npm install --omit=dev --no-fund --no-audit --loglevel=error"
        
        if (Test-Path "node_modules\better-sqlite3") {
            Write-Info "Rebuilding better-sqlite3..."
            cmd /c "npm rebuild better-sqlite3 --loglevel=error"
        }
    } finally {
        Pop-Location
    }
    Write-Success "Dependencies ready"
}

function Ensure-RuntimeHome {
    param([string]$Agent, [string]$HomeDir, [string]$Prefix)
    
    foreach ($Sub in @("data", "skills", "logs", "daemon")) {
        New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir $Sub) -ErrorAction SilentlyContinue | Out-Null
    }
    
    $Template = Join-Path $Prefix "templates\config.$Agent.yaml"
    if (-not (Test-Path $Template)) { $Template = Join-Path $ScriptDir "templates\config.$Agent.yaml" }
    
    if (-not (Test-Path $Template)) {
        Write-Warn "Template missing: config.$Agent.yaml"
        return
    }
    
    $Target = Join-Path $HomeDir "config.yaml"
    if (-not (Test-Path $Target)) {
        Copy-Item -Path $Template -Destination $Target
        Write-Success "Wrote config.yaml from template"
    } else {
        Write-Success "config.yaml exists — kept as-is"
    }
}

function Wait-ForViewer {
    param([int]$Port, [int]$Timeout = 60)
    $Url = "http://127.0.0.1:$Port/"
    $Elapsed = 0
    Write-Host "  Starting Memory Viewer..." -NoNewline
    while ($Elapsed -lt $Timeout) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
            Write-Host "`r                                      `r" -NoNewline
            Write-Success "Memory Viewer is ready: $Url"
            return $true
        } catch {
            Start-Sleep -Seconds 1
            $Elapsed++
        }
    }
    Write-Host "`r                                      `r" -NoNewline
    Write-Warn "Memory Viewer not ready after ${Timeout}s"
    return $false
}

function Install-OpenClaw {
    Write-Host "`n=== OpenClaw Install ===" -ForegroundColor Cyan
    $Prefix = Join-Path $env:USERPROFILE ".openclaw\extensions\$PluginId"
    $HomeDir = Join-Path $env:USERPROFILE ".openclaw\memos-plugin"
    $ConfigPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"
    
    $OcBin = Get-Command "openclaw" -ErrorAction SilentlyContinue
    if ($OcBin) {
        Write-Info "Stopping OpenClaw gateway"
        cmd /c "openclaw gateway stop"
        Start-Sleep -Seconds 1
    }
    
    Deploy-Tarball -Prefix $Prefix
    
    $RuntimeEntry = "./dist/adapters/openclaw/index.js"
    if (-not (Test-Path (Join-Path $Prefix "dist\adapters\openclaw\index.js"))) {
        Stop-Die "OpenClaw runtime entry missing."
    }
    
    Ensure-RuntimeHome -Agent "openclaw" -HomeDir $HomeDir -Prefix $Prefix
    
    $PackageJson = Get-Content (Join-Path $Prefix "package.json") -Raw | ConvertFrom-Json
    $PluginVersion = $PackageJson.version
    
    $PluginJsonContent = @"
{
  "id": "$PluginId",
  "name": "MemOS Local Memory (V7)",
  "description": "Reflect2Evolve V7 memory.",
  "kind": "memory",
  "version": "$PluginVersion",
  "homepage": "https://github.com/MemTensor/MemOS",
  "extensions": ["$RuntimeEntry"],
  "contracts": {
    "tools": ["memory_search", "memory_get", "memory_timeline", "skill_list", "memory_environment", "skill_get"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "viewerPort": { "type": "number", "description": "Memory Viewer HTTP port (default $OpenClawPort)" }
    }
  }
}
"@
    Set-Content -Path (Join-Path $Prefix "openclaw.plugin.json") -Value $PluginJsonContent -Encoding UTF8
    
    Write-Info "Patching openclaw.json"
    $LegacyIds = @("memos-local-openclaw-plugin")
    $LegacyJson = ($LegacyIds -join ',')
    $SourceKindStr = if ($SourceKind -eq 'path') { 'path' } else { 'npm' }
    
    $env:PLUGIN_ID = $PluginId
    $env:INSTALL_PATH = $Prefix
    $env:SOURCE_KIND = $SourceKindStr
    $env:SOURCE_SPEC = $SourceSpec
    $env:PLUGIN_VERSION = $PluginVersion
    $env:LEGACY_JSON = $LegacyJson
    $env:CONFIG_PATH = $ConfigPath

    $NodeScript = @"
const fs = require('fs');
const {
  CONFIG_PATH: configPath, PLUGIN_ID: pluginId, INSTALL_PATH: installPath,
  SOURCE_KIND: sourceKind, SOURCE_SPEC: sourceSpec,
  PLUGIN_VERSION: pluginVersion, LEGACY_JSON: legacyCsv,
} = process.env;
const legacyIds = (legacyCsv || '').split(',').filter(Boolean);

let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  }
}

if (!config.gateway || typeof config.gateway !== 'object' || Array.isArray(config.gateway)) {
  config.gateway = {};
}
if (!config.gateway.mode) config.gateway.mode = 'local';

if (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins)) {
  config.plugins = {};
}
config.plugins.enabled = true;

if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
if (!config.plugins.allow.includes(pluginId)) config.plugins.allow.push(pluginId);

for (const legacyId of legacyIds) {
  if (config.plugins.entries?.[legacyId]) delete config.plugins.entries[legacyId];
  if (config.plugins.installs?.[legacyId]) delete config.plugins.installs[legacyId];
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((x) => x !== legacyId);
  }
  if (config.plugins.slots && typeof config.plugins.slots === 'object') {
    for (const [slot, v] of Object.entries(config.plugins.slots)) {
      if (v === legacyId) delete config.plugins.slots[slot];
    }
  }
}

if (!config.plugins.slots || typeof config.plugins.slots !== 'object') config.plugins.slots = {};
config.plugins.slots.memory = pluginId;

if (!config.plugins.entries || typeof config.plugins.entries !== 'object') config.plugins.entries = {};
if (!config.plugins.entries[pluginId] || typeof config.plugins.entries[pluginId] !== 'object') {
  config.plugins.entries[pluginId] = {};
}
config.plugins.entries[pluginId].enabled = true;
if (config.plugins.entries[pluginId].hooks) delete config.plugins.entries[pluginId].hooks;

if (!config.plugins.installs || typeof config.plugins.installs !== 'object') config.plugins.installs = {};
const installsEntry = {
  source: sourceKind === 'path' ? 'path' : 'npm',
  installPath,
  version: pluginVersion,
  resolvedVersion: pluginVersion,
  installedAt: new Date().toISOString(),
};
if (sourceKind !== 'path') {
  installsEntry.spec = sourceSpec;
  installsEntry.resolvedName = '@memtensor/memos-local-plugin';
  installsEntry.resolvedSpec = sourceSpec;
}
config.plugins.installs[pluginId] = installsEntry;

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
"@

    $NodeScriptPath = Join-Path $env:TEMP "patch_openclaw.js"
    Set-Content -Path $NodeScriptPath -Value $NodeScript -Encoding UTF8
    node $NodeScriptPath
    Write-Success "openclaw.json patched"
    
    if ($OcBin) {
        Write-Info "Starting OpenClaw gateway"
        cmd /c "openclaw gateway start"
        if (Wait-ForViewer -Port $OpenClawPort) {
            Write-Success "OpenClaw install complete"
        } else {
            Write-Warn "Memory Viewer did not respond."
        }
    } else {
        Write-Warn "openclaw CLI not found. Start gateway manually."
    }
}

function Install-Hermes {
    Write-Host "`n=== Hermes Install ===" -ForegroundColor Cyan
    $Prefix = Join-Path $env:LOCALAPPDATA "hermes\memos-plugin"
    $HomeDir = $Prefix
    $ConfigFile = Join-Path $env:LOCALAPPDATA "hermes\config.yaml"
    $AdapterDir = Join-Path $Prefix "adapters\hermes"
    
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "bridge.cts" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -Name "hermes" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    
    Deploy-Tarball -Prefix $Prefix
    Ensure-RuntimeHome -Agent "hermes" -HomeDir $HomeDir -Prefix $Prefix
    
    Set-Content -Path (Join-Path $AdapterDir "bridge_path.txt") -Value (Join-Path $Prefix "bridge.cts") -Encoding UTF8
    
    $PythonBin = ""
    $VenvPy = Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\venv\Scripts\python.exe"
    if (Test-Path $VenvPy) { $PythonBin = $VenvPy }
    else { $PythonBin = (Get-Command "python.exe" -ErrorAction SilentlyContinue).Source }
    
    if (-not $PythonBin) { Stop-Die "Cannot locate Python for Hermes." }
    Write-Success "Python: $PythonBin"
    
    $PluginDir = ""
    $DefaultPluginDir = Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\plugins\memory"
    if (Test-Path $DefaultPluginDir) { $PluginDir = $DefaultPluginDir }
    else {
        # Fallback to python detection
        $PyCmd = "from pathlib import Path; import sys; import plugins.memory as pm; print(Path(pm.__file__).parent)"
        try {
            $PluginDir = & $PythonBin -c $PyCmd 2>$null
        } catch {}
    }
    
    if (-not $PluginDir -or -not (Test-Path $PluginDir)) { Stop-Die "plugins\memory not found" }
    
    $Target = Join-Path $PluginDir "memtensor"
    if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
    
    New-Item -ItemType Junction -Path $Target -Value (Join-Path $AdapterDir "memos_provider") | Out-Null
    Copy-Item -Path (Join-Path $AdapterDir "plugin.yaml") -Destination (Join-Path $AdapterDir "memos_provider\plugin.yaml") -ErrorAction SilentlyContinue
    Write-Success "Linked -> $Target"
    
    if (Test-Path $ConfigFile) {
        $PyScript = @"
import sys, yaml
path = sys.argv[1]
with open(path, encoding='utf-8') as f: cfg = yaml.safe_load(f) or {}
mem = cfg.get('memory')
if isinstance(mem, dict):
    mem['provider'] = 'memtensor'
    mem.setdefault('memory_enabled', True)
else:
    cfg['memory'] = {'provider': 'memtensor', 'memory_enabled': True}
with open(path, 'w', encoding='utf-8') as f:
    yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
"@
        $PyFile = Join-Path $env:TEMP "patch_config.py"
        Set-Content -Path $PyFile -Value $PyScript
        & $PythonBin $PyFile $ConfigFile
        Write-Success "config.yaml patched"
    } else {
        $ConfigContent = @"
memory:
  memory_enabled: true
  user_profile_enabled: true
  provider: memtensor
"@
        Set-Content -Path $ConfigFile -Value $ConfigContent -Encoding UTF8
        Write-Success "Created $ConfigFile"
    }
    
    Write-Info "Starting Memory Viewer daemon"
    $TsxBin = Join-Path $Prefix "node_modules\.bin\tsx.cmd"
    $BridgeCts = Join-Path $Prefix "bridge.cts"
    
    if ((Test-Path $TsxBin) -and (Test-Path $BridgeCts)) {
        $DaemonLog = Join-Path $Prefix "logs\daemon-start.log"
        $DaemonLogErr = Join-Path $Prefix "logs\daemon-start-err.log"
        Start-Process -FilePath $TsxBin -ArgumentList "$BridgeCts --agent=hermes --daemon" -WindowStyle Hidden -RedirectStandardOutput $DaemonLog -RedirectStandardError $DaemonLogErr
        
        if (Wait-ForViewer -Port $HermesPort -Timeout 120) {
            Write-Success "Memory Viewer daemon running"
        } else {
            Write-Warn "Memory Viewer did not respond within 120s."
        }
    } else {
        Write-Warn "tsx not found - skipping daemon start."
    }
}

if ($AgentSelection -eq "openclaw" -or $AgentSelection -eq "all") { Install-OpenClaw }
if ($AgentSelection -eq "hermes" -or $AgentSelection -eq "all") { Install-Hermes }

Write-Host "`n  ==================================================" -ForegroundColor Green
Write-Host "     Install finished successfully!                 " -ForegroundColor Green
Write-Host "  ==================================================`n" -ForegroundColor Green
