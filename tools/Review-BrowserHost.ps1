#Requires -Version 7
<#
.SYNOPSIS
The browser host lane (ADR-0035, ADR-0036): builds the one-page browser host and runs
Gate-BrowserHost.mjs in Edge from file://, with copies of Nendo Station and Deck dropped onto it and
carried by exported pages. The exported Station's download is then checked by the Windows Engine.

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
$fileUrl = { param($path) 'file:///' + ((Resolve-Path -LiteralPath $path).Path -replace '\\', '/') }
# Exported pages: the browser host carrying a copy of each file (ADR-0035).
$carry = Join-Path $repoRoot 'src/Nendo.Workbench/scripts/carry-file.mjs'
$stationPage = Join-Path $lane 'Nendo Station.html'
$deckPage = Join-Path $lane 'Deck.html'
& node $carry $page (Join-Path $repoRoot 'workspace/Nendo Station.nendo') $stationPage | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The exported Station page was not packed.' }
& node $carry $page (Join-Path $repoRoot 'workspace/Deck.nendo') $deckPage | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The exported Deck page was not packed.' }
$download = Join-Path $lane "downloaded-$runId.nendo"
$probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-BrowserHost.mjs'))
$probe = $probe.Replace('__PAGE_URL__', (& $fileUrl $page)).Replace('__STATION_BASE64__', $station).Replace('__DECK_BASE64__', $deck)
$probe = $probe.Replace('__STATION_PAGE_URL__', (& $fileUrl $stationPage)).Replace('__DECK_PAGE_URL__', (& $fileUrl $deckPage))
$probe = $probe.Replace('__DOWNLOAD_PATH__', ($download -replace '\\', '/'))
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

    # The exported page's download, opened by the Windows Engine: whole, and holding both edits.
    $checked = & dotnet run (Join-Path $PSScriptRoot 'Check-NendoFile.cs') -- $download incident incident.001 incidentSeverity incident incident.002 incidentTitle 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "The Windows Engine did not open the exported page's download: $checked" }
    $file = ([regex]::Match($checked, '\{"integrity"[^\r\n]+\}').Value) | ConvertFrom-Json
    if ($file.integrity -ne 'ok') { throw "The exported page's download failed its integrity check: $($file.integrity)." }
    if ($file.values[0] -ne 'Elevated' -or $file.values[1] -ne 'Kept across visits') {
        throw "The exported page's download does not hold its edits: $($file.values -join ', ')."
    }
    Write-Host "The exported page's download opens in the Windows Engine: integrity $($file.integrity), change $($file.changeSequence), both edits held."
}
finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close | Out-Null
    foreach ($scratch in @($probePath, $download, $stationPage, $deckPage)) {
        if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch }
    }
    Pop-Location
}
