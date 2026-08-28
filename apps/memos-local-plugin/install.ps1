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

function Invoke-NativeChecked {
    param(
        [string]$Command,
        [string[]]$Arguments,
        [string]$FailureMessage
    )
    & $Command @Arguments | Out-Host
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0) {
        throw "$FailureMessage (exit code $ExitCode)"
    }
}

function Invoke-OpenClawGatewayChecked {
    param(
        [ValidateSet("start", "stop")]
        [string]$Action
    )
    # PowerShell 5.1 can promote a native process' stderr to an ErrorRecord.
    # Capture it without turning it into a terminating PowerShell error, then
    # use the native exit code as the authoritative result.
    $PreviousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $GatewayOutput = @(& cmd.exe /d /c "openclaw gateway $Action" 2>&1)
        $ExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    foreach ($Line in $GatewayOutput) {
        Write-Host "$Line"
    }
    if ($ExitCode -ne 0) {
        throw "openclaw gateway $Action failed (exit code $ExitCode)"
    }
}

function Test-BetterSqlite3 {
    param([string]$NodeBin, [string]$Prefix)
    $SmokeScript = "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('SELECT 1');db.close();"
    Push-Location $Prefix
    try {
        & $NodeBin -e $SmokeScript *> $null
        return $LASTEXITCODE -eq 0
    } finally {
        Pop-Location
    }
}

function Resolve-HermesHostHome {
    $ConfiguredHome = $env:HERMES_HOME
    if ($ConfiguredHome -and $ConfiguredHome.Trim()) {
        $Candidate = [Environment]::ExpandEnvironmentVariables($ConfiguredHome.Trim())
        if ($Candidate -eq "~") {
            if (-not $env:USERPROFILE -or -not $env:USERPROFILE.Trim()) {
                Stop-Die "HERMES_HOME uses '~', but USERPROFILE is not set."
            }
            $UserProfile = $env:USERPROFILE.Trim()
            $Candidate = $UserProfile
        } elseif ($Candidate.StartsWith("~\") -or $Candidate.StartsWith("~/")) {
            if (-not $env:USERPROFILE -or -not $env:USERPROFILE.Trim()) {
                Stop-Die "HERMES_HOME uses '~', but USERPROFILE is not set."
            }
            $UserProfile = $env:USERPROFILE.Trim()
            $RelativeHome = $Candidate.Substring(2)
            $Candidate = Join-Path $UserProfile $RelativeHome
        }
        if (-not [IO.Path]::IsPathRooted($Candidate)) {
            Stop-Die "HERMES_HOME must be an absolute path: $ConfiguredHome"
        }
        return [IO.Path]::GetFullPath($Candidate)
    }

    if (-not $env:LOCALAPPDATA -or -not $env:LOCALAPPDATA.Trim()) {
        Stop-Die "LOCALAPPDATA is not set; set HERMES_HOME to the Hermes data directory."
    }
    $LocalAppData = $env:LOCALAPPDATA.Trim()
    return [IO.Path]::GetFullPath((Join-Path $LocalAppData "hermes"))
}

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
$HermesHome = Resolve-HermesHostHome
# Keep every child process on the same normalized host-data directory. This is
# process-scoped and does not overwrite the user's persisted environment.
$env:HERMES_HOME = $HermesHome
$HasOpenClaw = Test-Path "$env:USERPROFILE\.openclaw"
$HasHermes = Test-Path $HermesHome

Write-Host "`n  Detected agents:" -ForegroundColor White
if ($HasOpenClaw) { Write-Host "    - OpenClaw   (~/.openclaw)" -ForegroundColor Green }
else { Write-Host "    - OpenClaw   (not installed)" -ForegroundColor DarkGray }

if ($HasHermes) { Write-Host "    - Hermes     ($HermesHome)" -ForegroundColor Green }
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
    if (-not $HasOpenClaw -and -not $HasHermes) { Stop-Die "Neither ~/.openclaw nor Hermes home ($HermesHome) exists. Install one first." }
    if ($HasOpenClaw -and $HasHermes) { $AgentSelection = "all" }
    elseif ($HasOpenClaw) { $AgentSelection = "openclaw" }
    else { $AgentSelection = "hermes" }
    Write-Success "Auto-detected: $AgentSelection"
}

# Resolve tarball
$StageDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString())) -Force
try {
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
        $NpmPackCommand = (Get-Command "npm.cmd" -ErrorAction SilentlyContinue).Source
        if (-not $NpmPackCommand) { $NpmPackCommand = (Get-Command "npm" -ErrorAction SilentlyContinue).Source }
        if (-not $NpmPackCommand) { throw "npm executable not found" }
        Invoke-NativeChecked -Command $NpmPackCommand -Arguments @(
            "pack", $SourceSpec, "--loglevel=error"
        ) -FailureMessage "npm pack failed"
        $BuiltTarball = (Get-ChildItem -Filter *.tgz | Select-Object -First 1).FullName
    } finally {
        Pop-Location
    }
    if (-not $BuiltTarball) { Stop-Die "npm pack failed for $SourceSpec." }
    Write-Success "Package downloaded: $(Split-Path $BuiltTarball -Leaf)"
}

function Deploy-Tarball {
    param(
        [string]$Prefix,
        [scriptblock]$BeforeSwap
    )
    Write-Info "Deploying to $Prefix"
    $Preserve = @("data", "logs", "skills", "daemon", ".migrations", "config.yaml", ".auth.json", ".memos-runtime-home")
    $StagedPrefix = Prepare-StagedPackage
    $BackupDir = "$Prefix.memos-backup-$([guid]::NewGuid().ToString('N'))"
    $HadExisting = Test-Path $Prefix
    $LiveMovedToBackup = $false
    $StagedMovedLive = $false
    $DeploySucceeded = $false

    try {
        # Staging can take minutes. Re-check immediately before swapping the
        # live tree so an active Hermes session cannot re-lock native modules.
        if ($BeforeSwap) {
            & $BeforeSwap
        }
        Stop-WindowsPluginBridges -Prefix $Prefix
        if ($HadExisting) {
            Move-Item -Path $Prefix -Destination $BackupDir -Force
            $LiveMovedToBackup = $true
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $Prefix -Parent) | Out-Null
        Move-Item -Path $StagedPrefix -Destination $Prefix -Force
        $StagedMovedLive = $true

        if ($HadExisting) {
            foreach ($Item in $Preserve) {
                $SavedItem = Join-Path $BackupDir $Item
                if (Test-Path $SavedItem) {
                    $Dst = Join-Path $Prefix $Item
                    if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
                    Copy-Item -Path $SavedItem -Destination $Dst -Recurse -Force
                }
            }
        }

        if (-not (Test-Path (Join-Path $Prefix "package.json"))) {
            throw "Extraction failed: package.json missing after staged deploy"
        }
        Write-Success "Package extracted"
        Write-Success "Dependencies ready"
        Write-Warn "Local MiniLM model weights are not bundled."
        Write-Host "       If embedding.provider is local, the first Viewer test or use downloads about 23 MB from Hugging Face."
        $DeploySucceeded = $true
    } catch {
        $DeployError = $_
        if ($StagedMovedLive -and (Test-Path $Prefix)) {
            Remove-Item -Recurse -Force $Prefix -ErrorAction SilentlyContinue
        }
        if ($LiveMovedToBackup -and (Test-Path $BackupDir)) {
            Move-Item -Path $BackupDir -Destination $Prefix -Force
        }
        if (Test-Path $StagedPrefix) {
            Remove-Item -Recurse -Force $StagedPrefix -ErrorAction SilentlyContinue
        }
        throw $DeployError
    } finally {
        if ($DeploySucceeded -and (Test-Path $BackupDir)) {
            Remove-Item -Recurse -Force $BackupDir -ErrorAction SilentlyContinue
        }
    }
}

function Prepare-StagedPackage {
    $StagedPrefix = Join-Path $env:TEMP ("memos-package-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $StagedPrefix | Out-Null
    $SystemNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    $NodeForBridge = if (Test-Path $SystemNode) {
        $SystemNode
    } else {
        (Get-Command "node.exe" -ErrorAction SilentlyContinue).Source
    }
    if (-not $NodeForBridge) {
        Remove-Item -Recurse -Force $StagedPrefix -ErrorAction SilentlyContinue
        throw "Node.js executable not found for staged install"
    }
    $NpmCommand = (Get-Command "npm.cmd" -ErrorAction SilentlyContinue).Source
    if (-not $NpmCommand) { $NpmCommand = (Get-Command "npm" -ErrorAction SilentlyContinue).Source }
    if (-not $NpmCommand) {
        Remove-Item -Recurse -Force $StagedPrefix -ErrorAction SilentlyContinue
        throw "npm executable not found for staged install"
    }

    try {
        Invoke-NativeChecked -Command "tar" -Arguments @(
            "xzf", $BuiltTarball, "-C", $StagedPrefix, "--strip-components=1"
        ) -FailureMessage "Package extraction failed"
        if (-not (Test-Path (Join-Path $StagedPrefix "package.json"))) {
            throw "Package extraction failed: package.json missing"
        }

        Write-Info "Installing npm dependencies in staging"
        $PreviousSkipSetup = $env:MEMOS_SKIP_SETUP
        Push-Location $StagedPrefix
        try {
            $env:MEMOS_SKIP_SETUP = "1"
            # npm 11 still resolves omitted DSH development peer trees unless
            # legacy peer resolution is requested for the packed runtime.
            Invoke-NativeChecked -Command $NpmCommand -Arguments @(
                "install", "--omit=dev", "--legacy-peer-deps", "--no-fund", "--no-audit", "--loglevel=error"
            ) -FailureMessage "npm install failed"
        } finally {
            if ($null -eq $PreviousSkipSetup) {
                Remove-Item Env:MEMOS_SKIP_SETUP -ErrorAction SilentlyContinue
            } else {
                $env:MEMOS_SKIP_SETUP = $PreviousSkipSetup
            }
            Pop-Location
        }

        if (-not (Test-BetterSqlite3 -NodeBin $NodeForBridge -Prefix $StagedPrefix)) {
            Write-Info "Rebuilding better-sqlite3 in staging..."
            Push-Location $StagedPrefix
            try {
                Invoke-NativeChecked -Command $NpmCommand -Arguments @(
                    "rebuild", "better-sqlite3", "--loglevel=error"
                ) -FailureMessage "better-sqlite3 rebuild failed"
            } finally {
                Pop-Location
            }
            if (-not (Test-BetterSqlite3 -NodeBin $NodeForBridge -Prefix $StagedPrefix)) {
                throw "better-sqlite3 is not loadable after rebuild"
            }
        }

        Set-Content -Path (Join-Path $StagedPrefix ".memos-node-bin") -Value $NodeForBridge -Encoding UTF8
        return $StagedPrefix
    } catch {
        Remove-Item -Recurse -Force $StagedPrefix -ErrorAction SilentlyContinue
        throw
    }
}

function Stop-WindowsPluginBridges {
    param([string]$Prefix)
    $ResolvedPrefix = [IO.Path]::GetFullPath($Prefix)
    $BridgePattern = 'bridge\.(cts|cjs|mts|mjs)'
    $Deadline = [DateTime]::UtcNow.AddSeconds(15)
    $QuietSince = $null

    do {
        $BridgeProcesses = @(
            Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.CommandLine -and
                    $_.CommandLine.IndexOf($ResolvedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                    $_.CommandLine -match $BridgePattern
                }
        )
        foreach ($Process in $BridgeProcesses) {
            Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        if ($BridgeProcesses.Count -eq 0) {
            if ($null -eq $QuietSince) {
                $QuietSince = [DateTime]::UtcNow
            } elseif (([DateTime]::UtcNow - $QuietSince).TotalSeconds -ge 1) {
                return
            }
        } else {
            $QuietSince = $null
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $Deadline)

    throw "MemOS bridge processes are still running. Close Hermes completely and run the installer again."
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

function Test-HermesRuntimeData {
    param([string]$HomeDir)
    if (Test-Path (Join-Path $HomeDir "config.yaml") -PathType Leaf) { return $true }
    if (Test-Path (Join-Path $HomeDir ".auth.json") -PathType Leaf) { return $true }
    $SkillsDir = Join-Path $HomeDir "skills"
    if (Test-Path $SkillsDir -PathType Container) {
        return $null -ne (Get-ChildItem -Path $SkillsDir -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
    }
    return $false
}

function Resolve-HermesRuntimeHome {
    param([string]$InstallRoot)

    if ($env:MEMOS_HOME -and $env:MEMOS_HOME.Trim()) {
        return [PSCustomObject]@{ Path = [IO.Path]::GetFullPath($env:MEMOS_HOME); Source = "environment"; Persist = $true }
    }
    if ($env:MEMOS_CONFIG_FILE -and $env:MEMOS_CONFIG_FILE.Trim()) {
        $ConfigParent = Split-Path -Parent ([IO.Path]::GetFullPath($env:MEMOS_CONFIG_FILE))
        return [PSCustomObject]@{ Path = $ConfigParent; Source = "config-environment"; Persist = $true }
    }

    $MarkerFile = Join-Path $InstallRoot ".memos-runtime-home"
    if (Test-Path $MarkerFile -PathType Leaf) {
        try {
            $Marker = Get-Content -Path $MarkerFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($Marker.version -eq 1 -and $Marker.path -and $Marker.path.Trim()) {
                return [PSCustomObject]@{ Path = [IO.Path]::GetFullPath($Marker.path); Source = "marker"; Persist = $false }
            }
        } catch {
            Write-Warn "Ignoring invalid runtime-home marker: $MarkerFile"
        }
    }

    $LegacyHome = Join-Path $env:USERPROFILE ".hermes\memos-plugin"
    $LegacyDb = Join-Path $LegacyHome "data\memos.db"
    $CanonicalDb = Join-Path $InstallRoot "data\memos.db"
    $HasLegacyDb = Test-Path $LegacyDb -PathType Leaf
    $HasCanonicalDb = Test-Path $CanonicalDb -PathType Leaf
    if ($HasLegacyDb -and $HasCanonicalDb) {
        Stop-Die "both Windows Hermes runtime homes contain a database. Set MEMOS_HOME to '$LegacyHome' or '$InstallRoot', then run the installer again."
    }

    if ($HasLegacyDb) {
        return [PSCustomObject]@{ Path = $LegacyHome; Source = "legacy-database"; Persist = $true }
    }
    if ($HasCanonicalDb) {
        return [PSCustomObject]@{ Path = $InstallRoot; Source = "canonical-database"; Persist = $true }
    }
    if (Test-HermesRuntimeData -HomeDir $LegacyHome) {
        return [PSCustomObject]@{ Path = $LegacyHome; Source = "legacy-data"; Persist = $true }
    }
    return [PSCustomObject]@{ Path = $InstallRoot; Source = "new-install"; Persist = $true }
}

function Write-RuntimeHomeMarker {
    param([string]$InstallRoot, [string]$RuntimeHome, [string]$Source)
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    $MarkerFile = Join-Path $InstallRoot ".memos-runtime-home"
    $TempFile = "$MarkerFile.$PID.tmp"
    $Payload = [ordered]@{ version = 1; path = [IO.Path]::GetFullPath($RuntimeHome); source = $Source }
    $Json = ($Payload | ConvertTo-Json) + "`n"
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($TempFile, $Json, $Utf8NoBom)
    Move-Item -Path $TempFile -Destination $MarkerFile -Force
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
    $GatewayRecoveryState = "inactive"
    try {
        if ($OcBin) {
            Write-Info "Stopping OpenClaw gateway"
            Invoke-OpenClawGatewayChecked -Action "stop"
            $GatewayRecoveryState = "needs_recovery"
            Start-Sleep -Seconds 1
        }

        Deploy-Tarball -Prefix $Prefix

        $RuntimeEntry = "./dist/adapters/openclaw/index.js"
        if (-not (Test-Path (Join-Path $Prefix "dist\adapters\openclaw\index.js"))) {
            throw "OpenClaw runtime entry missing."
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
    "tools": ["memos_search", "memos_get", "memos_timeline", "memos_skill_list", "memos_environment", "memos_skill_get"]
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
    $env:PLUGIN_ID = $PluginId
    $env:LEGACY_JSON = $LegacyJson
    $env:CONFIG_PATH = $ConfigPath

    $NodeScript = @"
const fs = require('fs');
const { CONFIG_PATH: configPath, PLUGIN_ID: pluginId, LEGACY_JSON: legacyCsv } = process.env;
const legacyIds = (legacyCsv || '').split(',').filter(Boolean);
const MEMOS_TOOL_NAMES = [
  'memos_search',
  'memos_get',
  'memos_timeline',
  'memos_environment',
  'memos_skill_list',
  'memos_skill_get',
];

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

if (!config.tools || typeof config.tools !== 'object' || Array.isArray(config.tools)) {
  config.tools = {};
}
if (!Array.isArray(config.tools.alsoAllow)) config.tools.alsoAllow = [];
for (const toolName of MEMOS_TOOL_NAMES) {
  if (!config.tools.alsoAllow.includes(toolName)) config.tools.alsoAllow.push(toolName);
}

if (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins)) {
  config.plugins = {};
}
config.plugins.enabled = true;

if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
if (!config.plugins.allow.includes(pluginId)) config.plugins.allow.push(pluginId);

for (const legacyId of legacyIds) {
  if (config.plugins.entries?.[legacyId]) delete config.plugins.entries[legacyId];
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((x) => x !== legacyId);
  }
  if (config.plugins.slots && typeof config.plugins.slots === 'object') {
    for (const [slot, v] of Object.entries(config.plugins.slots)) {
      if (v === legacyId) delete config.plugins.slots[slot];
    }
  }
}

// `plugins.installs` was optional through OpenClaw 2026.4.24 and moved to
// machine-managed plugin index state in 2026.4.25. The extension already lives
// in OpenClaw's standard discovery directory, so neither generation requires a
// hand-written MemOS install record. Remove only records owned by this installer
// so older OpenClaw releases retain metadata for unrelated plugins.
if (
  config.plugins.installs &&
  typeof config.plugins.installs === 'object' &&
  !Array.isArray(config.plugins.installs)
) {
  delete config.plugins.installs[pluginId];
  for (const legacyId of legacyIds) delete config.plugins.installs[legacyId];
  if (Object.keys(config.plugins.installs).length === 0) delete config.plugins.installs;
} else if (Object.prototype.hasOwnProperty.call(config.plugins, 'installs')) {
  // A malformed legacy value is invalid on old hosts and cannot carry records
  // worth preserving.
  delete config.plugins.installs;
}

if (!config.plugins.slots || typeof config.plugins.slots !== 'object') config.plugins.slots = {};
config.plugins.slots.memory = pluginId;

if (!config.plugins.entries || typeof config.plugins.entries !== 'object') config.plugins.entries = {};
if (!config.plugins.entries[pluginId] || typeof config.plugins.entries[pluginId] !== 'object') {
  config.plugins.entries[pluginId] = {};
}
config.plugins.entries[pluginId].enabled = true;
// OpenClaw requires an explicit opt-in before conversation-bearing hooks can
// inject memories at prompt time or capture completed turns at agent_end.
// Preserve any existing hook settings while enforcing the permission MemOS
// needs; replacing the object would silently discard user/host configuration.
if (
  !config.plugins.entries[pluginId].hooks ||
  typeof config.plugins.entries[pluginId].hooks !== 'object' ||
  Array.isArray(config.plugins.entries[pluginId].hooks)
) {
  config.plugins.entries[pluginId].hooks = {};
}
config.plugins.entries[pluginId].hooks.allowConversationAccess = true;

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
"@

        $NodeScriptPath = Join-Path $env:TEMP "patch_openclaw.js"
        Set-Content -Path $NodeScriptPath -Value $NodeScript -Encoding UTF8
        Invoke-NativeChecked -Command "node" -Arguments @($NodeScriptPath) -FailureMessage "Failed to patch openclaw.json"
        Write-Success "openclaw.json patched"

        if ($OcBin) {
            Write-Info "Starting OpenClaw gateway"
            try {
                Invoke-OpenClawGatewayChecked -Action "start"
            } catch {
                # The regular final start already ran. Do not invoke it a
                # second time from recovery cleanup and hide the real failure.
                $GatewayRecoveryState = "final_failed"
                throw
            }
            $GatewayRecoveryState = "inactive"
            if (Wait-ForViewer -Port $OpenClawPort) {
                Write-Success "OpenClaw install complete"
            } else {
                Write-Warn "Memory Viewer did not respond."
            }
        } else {
            Write-Warn "openclaw CLI not found. Start gateway manually."
        }
    } finally {
        if ($GatewayRecoveryState -eq "needs_recovery") {
            Write-Warn "Install failed after stopping OpenClaw; restarting the gateway."
            try {
                Invoke-OpenClawGatewayChecked -Action "start"
                Write-Success "OpenClaw gateway recovered"
            } catch {
                Write-Warn "OpenClaw gateway recovery failed: $($_.Exception.Message)"
            }
        }
    }
}

function Install-Hermes {
    Write-Host "`n=== Hermes Install ===" -ForegroundColor Cyan
    # MemOS package/runtime files remain in the canonical LocalAppData install
    # root. Hermes host data below follows HERMES_HOME and may live elsewhere.
    $Prefix = Join-Path $env:LOCALAPPDATA "hermes\memos-plugin"
    $RuntimeSelection = Resolve-HermesRuntimeHome -InstallRoot $Prefix
    $HomeDir = $RuntimeSelection.Path
    $ConfigFile = Join-Path $HermesHome "config.yaml"
    $AdapterDir = Join-Path $Prefix "adapters\hermes"

    Deploy-Tarball -Prefix $Prefix -BeforeSwap {
        Get-Process -Name "hermes" -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
    if ($RuntimeSelection.Persist) {
        Write-RuntimeHomeMarker -InstallRoot $Prefix -RuntimeHome $HomeDir -Source $RuntimeSelection.Source
    }
    Write-Success "Runtime home: $HomeDir ($($RuntimeSelection.Source))"
    Ensure-RuntimeHome -Agent "hermes" -HomeDir $HomeDir -Prefix $Prefix

    $BridgeEntry = Join-Path $Prefix "dist\bridge.cjs"
    if (-not (Test-Path $BridgeEntry)) { $BridgeEntry = Join-Path $Prefix "bridge.cts" }
    Set-Content -Path (Join-Path $AdapterDir "bridge_path.txt") -Value $BridgeEntry -Encoding UTF8

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

    $VersionSyncScript = Join-Path $Prefix "scripts\sync-hermes-version.cjs"
    if (Test-Path $VersionSyncScript) {
        & node $VersionSyncScript $Prefix
        if ($LASTEXITCODE -ne 0) {
            Stop-Die "Failed to synchronize Hermes plugin version metadata."
        }
    } else {
        Write-Warn "Hermes version sync helper missing; using packaged plugin.yaml as-is."
    }
    Copy-Item -Path (Join-Path $AdapterDir "plugin.yaml") -Destination (Join-Path $AdapterDir "memos_provider\plugin.yaml") -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $AdapterDir "memos_provider\plugin.yaml"))) {
        Write-Warning "plugin.yaml copy may have failed; verify $AdapterDir\memos_provider\plugin.yaml exists."
    }

    $UserPluginDir = Join-Path $HermesHome "plugins\memory"
    New-Item -ItemType Directory -Path $UserPluginDir -Force | Out-Null
    Write-Host "Ensuring user plugin dir: $UserPluginDir"
    $ProviderTargets = @(
        (Join-Path $PluginDir "memtensor"),
        (Join-Path $UserPluginDir "memtensor")
    )
    foreach ($Target in $ProviderTargets) {
        if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
        try {
            New-Item -ItemType Junction -Path $Target -Value (Join-Path $AdapterDir "memos_provider") -ErrorAction Stop | Out-Null
            Write-Success "Linked -> $Target"
        } catch {
            Write-Warning "Failed to create junction at $Target : $_"
        }
    }
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
    $NodeBin = Get-Content -Path (Join-Path $Prefix ".memos-node-bin") -ErrorAction SilentlyContinue
    if (-not $NodeBin) { $NodeBin = (Get-Command "node.exe" -ErrorAction SilentlyContinue).Source }
    $TsxBin = Join-Path $Prefix "node_modules\tsx\dist\cli.mjs"
    $BridgeCts = Join-Path $Prefix "bridge.cts"
    $BridgeCjs = Join-Path $Prefix "dist\bridge.cjs"
    $BridgeEntry = $BridgeCjs
    if (-not (Test-Path $BridgeEntry)) { $BridgeEntry = $BridgeCts }

    if ($NodeBin -and (Test-Path $BridgeEntry) -and ($BridgeEntry.EndsWith(".cjs") -or (Test-Path $TsxBin))) {
        $DaemonLog = Join-Path $Prefix "logs\daemon-start.log"
        $DaemonLogErr = Join-Path $Prefix "logs\daemon-start-err.log"
        if ($BridgeEntry.EndsWith(".cjs")) {
            $DaemonArgs = "`"$BridgeEntry`" --agent=hermes --daemon --home=`"$HomeDir`""
            Start-Process -FilePath $NodeBin -ArgumentList $DaemonArgs -WindowStyle Hidden -RedirectStandardOutput $DaemonLog -RedirectStandardError $DaemonLogErr
        } else {
            $DaemonArgs = "`"$TsxBin`" `"$BridgeEntry`" --agent=hermes --daemon --home=`"$HomeDir`""
            Start-Process -FilePath $NodeBin -ArgumentList $DaemonArgs -WindowStyle Hidden -RedirectStandardOutput $DaemonLog -RedirectStandardError $DaemonLogErr
        }

        if (Wait-ForViewer -Port $HermesPort -Timeout 120) {
            Write-Success "Memory Viewer daemon running"
        } else {
            Write-Warn "Memory Viewer did not respond within 120s."
        }
    } else {
        Write-Warn "node or bridge runtime not found - skipping daemon start."
    }
}

if ($AgentSelection -eq "openclaw" -or $AgentSelection -eq "all") { Install-OpenClaw }
if ($AgentSelection -eq "hermes" -or $AgentSelection -eq "all") { Install-Hermes }

Write-Host "`n  ==================================================" -ForegroundColor Green
Write-Host "     Install finished successfully!                 " -ForegroundColor Green
Write-Host "  ==================================================`n" -ForegroundColor Green
} finally {
    if ($StageDir -and (Test-Path $StageDir)) {
        Remove-Item -Recurse -Force $StageDir -ErrorAction SilentlyContinue
    }
}
