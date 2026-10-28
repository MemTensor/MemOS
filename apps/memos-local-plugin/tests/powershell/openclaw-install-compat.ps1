param([string]$Installer = (Join-Path $PSScriptRoot '..\..\install.ps1'))
$ErrorActionPreference = 'Stop'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $Installer), [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
$Definition = $Ast.Find({ param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $Node.Name -eq 'Invoke-OpenClawGatewayChecked'
}, $true)
Invoke-Expression $Definition.Extent.Text
$Policy = $Ast.Find({ param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $Node.Name -eq 'Enable-OpenClawMemoryPlugin'
}, $true)
if (-not $Policy) { throw 'Missing host policy helper' }
Invoke-Expression $Policy.Extent.Text

# Exercise the real PowerShell helper with a fake native command boundary.
function cmd.exe {
    param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Arguments)
    $Command = [string]$Arguments[-1]
    $script:Calls.Add($Command)
    $global:LASTEXITCODE = 0
    if ($Command -eq 'openclaw gateway stop --help') {
        if ($script:Modern) { return 'Options: --force  Allow stop from a non-interactive shell' }
        return 'Options: --json'
    }
    if ($Command -eq 'openclaw config --help') {
        if ($script:Modern) { return 'validate' }
        return 'get set'
    }
    if ($Command -eq 'openclaw plugins enable --help') {
        $Probe = Get-Content $env:OPENCLAW_CONFIG_PATH -Raw | ConvertFrom-Json
        if ($Probe.plugins.enabled -ne $false) { throw 'Help probe can start plugins' }
        $script:ProbeDir = $env:OPENCLAW_STATE_DIR
        if ($script:Modern) { return '--accept-capabilities' }
        return 'enable <id>'
    }
    if ($Command -eq $script:FailPolicy) { $global:LASTEXITCODE = 19; return 'simulated policy failure' }
    if ($script:Fail) { $global:LASTEXITCODE = 17; return 'simulated service failure' }
    if ($script:Modern -and $Command -eq 'openclaw gateway stop') {
        $global:LASTEXITCODE = 1
        return 'Re-run with --force from a non-interactive shell'
    }
    return 'Service action completed'
}

foreach ($Modern in @($false, $true)) {
    $script:Modern = $Modern
    $script:Fail = $false
    $script:Calls = New-Object 'System.Collections.Generic.List[string]'
    Invoke-OpenClawGatewayChecked -Action stop
    $Expected = if ($Modern) { 'openclaw gateway stop --force' } else { 'openclaw gateway stop' }
    if ($script:Calls[-1] -ne $Expected) { throw "Wrong stop command: $($script:Calls[-1])" }
    Invoke-OpenClawGatewayChecked -Action start
    if ($script:Calls[-1] -ne 'openclaw gateway start') { throw 'Start received stop-only arguments' }
    Write-Output "PASS gateway stop/start (modern=$Modern)"
}
$script:Fail = $true
$Caught = $false
try { Invoke-OpenClawGatewayChecked -Action start } catch { $Caught = $true }
if (-not $Caught) { throw 'Native service failure was ignored' }
Write-Output 'PASS native failure propagation'

$script:Fail = $false
$OriginalState = $env:OPENCLAW_STATE_DIR
$OriginalConfig = $env:OPENCLAW_CONFIG_PATH
foreach ($Modern in @($false, $true)) {
    $script:Modern = $Modern
    $script:FailPolicy = ''
    $script:Calls.Clear()
    Enable-OpenClawMemoryPlugin
    $Accepted = $script:Calls.Contains('openclaw plugins enable memos-local-plugin --accept-capabilities')
    if ($Accepted -ne $Modern) { throw 'Capability consent feature detection failed' }
    if ($env:OPENCLAW_STATE_DIR -ne $OriginalState -or $env:OPENCLAW_CONFIG_PATH -ne $OriginalConfig) { throw 'Host paths not restored' }
    if (Test-Path $script:ProbeDir) { throw 'Temporary help configuration leaked' }
    Write-Output "PASS host policy (modern=$Modern)"
}
$script:Modern = $true
foreach ($Failure in @('openclaw config validate', 'openclaw plugins enable memos-local-plugin --accept-capabilities')) {
    $script:FailPolicy = $Failure
    $Caught = $false
    try { Enable-OpenClawMemoryPlugin } catch { $Caught = $true }
    if (-not $Caught) { throw 'Host policy failure was ignored' }
    if ($env:OPENCLAW_STATE_DIR -ne $OriginalState -or $env:OPENCLAW_CONFIG_PATH -ne $OriginalConfig) { throw 'Host paths not restored after failure' }
    if (Test-Path $script:ProbeDir) { throw 'Temporary help configuration leaked after failure' }
    Write-Output "PASS failure propagation: $Failure"
}
