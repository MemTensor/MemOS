<#
.SYNOPSIS
    install.ps1 — Windows installer for @memtensor/memos-local-plugin.

.DESCRIPTION
    Mirrors install.sh:
      1. Deploys plugin source to %USERPROFILE%\.<agent>\plugins\memos-local-plugin\
         (override with -Prefix).
      2. Creates runtime layout under %USERPROFILE%\.<agent>\memos-plugin\
         (override with -HomeDir).
      3. Generates config.yaml from templates\config.<agent>.yaml unless one
         already exists. Use -ForceConfig to overwrite.
      4. Hands off to adapters\<agent>\install.<agent>.ps1 if present.

.PARAMETER Agent
    "openclaw" or "hermes".

.PARAMETER Prefix
    Override the code install directory.

.PARAMETER HomeDir
    Override the runtime data directory.

.PARAMETER ForceConfig
    Overwrite an existing config.yaml.

.PARAMETER Uninstall
    Remove the deployed code (runtime data is preserved).
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true, Position=0)]
  [ValidateSet("openclaw","hermes")]
  [string]$Agent,

  [string]$Prefix,
  [string]$HomeDir,
  [switch]$ForceConfig,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

function Write-Info($msg)  { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "[install] $msg" -ForegroundColor Yellow }
function Stop-Die($msg)    { Write-Host "[install] $msg" -ForegroundColor Red; exit 1 }

$DefaultPrefix = Join-Path $HOME ".$Agent\plugins\memos-local-plugin"
$DefaultHome   = Join-Path $HOME ".$Agent\memos-plugin"
if (-not $Prefix)  { $Prefix  = $DefaultPrefix }
if (-not $HomeDir) { $HomeDir = $DefaultHome }

if ($Uninstall) {
  Write-Info "Uninstalling code from $Prefix (runtime data at $HomeDir is preserved)"
  if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix }
  Write-Info "Done."
  exit 0
}

# 1. deploy package contents
Write-Info "Deploying plugin code -> $Prefix"
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$exclude = @("node_modules","tests",".git")
robocopy $ScriptDir $Prefix /MIR /XD $exclude | Out-Null

# 2. runtime dirs
Write-Info "Ensuring runtime directory layout under $HomeDir"
foreach ($sub in @("data","skills","logs","daemon")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir $sub) | Out-Null
}

# 3. config.yaml
$Template = Join-Path $ScriptDir "templates\config.$Agent.yaml"
$Target   = Join-Path $HomeDir "config.yaml"
if (-not (Test-Path $Template)) {
  Write-Warn2 "Template missing: $Template (skipping config generation)"
} elseif ((Test-Path $Target) -and -not $ForceConfig) {
  Write-Info "config.yaml already exists at $Target -- keeping it (use -ForceConfig to overwrite)"
} else {
  Write-Info "Writing config.yaml -> $Target"
  Copy-Item -Force $Template $Target
}

$UserReadme = Join-Path $ScriptDir "templates\README.user.md"
if (Test-Path $UserReadme) {
  Copy-Item -Force $UserReadme (Join-Path $HomeDir "README.md")
}

# 4. adapter-specific step
$Sub = Join-Path $ScriptDir "adapters\$Agent\install.$Agent.ps1"
if (Test-Path $Sub) {
  Write-Info "Running adapter installer: $Sub"
  & $Sub -Agent $Agent -Prefix $Prefix -HomeDir $HomeDir
} else {
  Write-Warn2 "No adapter installer at $Sub (will be added in a later phase)"
}

Write-Info "Install complete."
Write-Info "  Code:    $Prefix"
Write-Info "  Data:    $HomeDir"
Write-Info "  Config:  $Target"
