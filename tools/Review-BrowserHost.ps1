#Requires -Version 7
<#
.SYNOPSIS
The browser host lane (ADR-0036): builds the one-page browser host and runs Gate-BrowserHost.mjs in
Edge from file://, with copies of Nendo Station and Deck dropped onto it.

.PARAMETER SkipBuild
Use the page already in artifacts/browser-host.

.PARAMETER SkipWorkbenchBuild
Build the page from the Workbench's sources without running its full build first (the production
gate has just built it).
#>
[CmdletBinding()]
param([switch]$SkipBuild, [switch]$SkipWorkbenchBuild)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repoRoot 'artifacts/browser-host'
$lane = Join-Path $output 'lane'
$runId = [Guid]::NewGuid().ToString('N')
$session = "nendo-browser-host-$runId".Substring(0, 30)

if (-not $SkipBuild) {
    $buildArguments = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Build-BrowserHost.ps1'))
    if ($SkipWorkbenchBuild) { $buildArguments += '-SkipWorkbenchBuild' }
    & pwsh @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'The browser host did not build.' }
}
$page = Join-Path $output 'Nendo.html'
if (-not (Test-Path -LiteralPath $page)) { throw "No browser host page at $page." }
New-Item -ItemType Directory -Force $lane | Out-Null

# The workspace files are read, never opened or written: their bytes are dropped onto the page.
$station = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $repoRoot 'workspace/Nendo Station.nendo')))
$deck = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $repoRoot 'workspace/Deck.nendo')))
$pageUrl = 'file:///' + ((Resolve-Path -LiteralPath $page).Path -replace '\\', '/')
$probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-BrowserHost.mjs'))
$probe = $probe.Replace('__PAGE_URL__', $pageUrl).Replace('__STATION_BASE64__', $station).Replace('__DECK_BASE64__', $deck)
$probePath = Join-Path $lane "probe-$runId.mjs"
[IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))

# playwright-cli writes its page snapshots into the current directory.
Push-Location $lane
try {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The browser host lane's browser did not start." }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    [IO.File]::WriteAllText((Join-Path $lane 'browser-results.txt'), $ran, [Text.UTF8Encoding]::new($false))
    # A run that stops at a modal returns 0 with no result, so the completion mark decides.
    $resultLine = [regex]::Match($ran, '### Result\r?\n(\{[^\r\n]+\})')
    if ($exitCode -ne 0 -or -not $resultLine.Success) {
        $errorLine = [regex]::Match($ran, '### Error\r?\n([^\r\n]+)')
        if ($errorLine.Success) { Write-Host $errorLine.Groups[1].Value } else { Write-Host ($ran.Substring(0, [Math]::Min(2400, $ran.Length))) }
        throw 'The browser host lane did not complete.'
    }
    $result = $resultLine.Groups[1].Value | ConvertFrom-Json
    if ($result.complete -ne $true) { throw 'The browser host lane returned an incomplete result.' }
    Write-Host ('Browser host lane passed: ' + ($result.checks -join ', ') + '. Browser exceptions: ' + $result.errors.Count)
}
finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close | Out-Null
    if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath }
    Pop-Location
}
