#Requires -Version 7
<#
.SYNOPSIS
The browser host lane (ADR-0035, ADR-0036): builds the one-page browser host and runs
Gate-BrowserHost.mjs in Edge from file://, with copies of Nendo Station and Deck dropped onto it and
exported as web pages by the code Export -> Web page runs. The exported Station's download is then
applied back to its source by the code Apply changes from a web page runs (tools/WebPageRoundTrip.cs).

.PARAMETER SkipBuild
Use the page already in artifacts/browser-host.

.PARAMETER SkipWorkbenchBuild
Build the page from the Workbench's sources without running its full build first (the production
gate has just built it).

.PARAMETER Browser
The browser to run in: msedge (the gate's), chrome or firefox (Playwright's own Firefox).

.PARAMETER Page
Run a page built elsewhere, such as an installed Nendo's WebPage\Nendo.html, instead of building one.

.PARAMETER Served
Publish the pages as a static site on a loopback port, each as the index.html of its own folder,
instead of opening them from disk.
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipWorkbenchBuild,
    [ValidateSet('msedge', 'chrome', 'firefox')][string]$Browser = 'msedge',
    [string]$Page,
    [switch]$Served
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repoRoot 'artifacts/browser-host'
$lane = Join-Path $output 'lane'
$runId = [Guid]::NewGuid().ToString('N')
$session = "nendo-browser-host-$runId".Substring(0, 30)

if (-not $SkipBuild -and -not $Page) {
    $buildArguments = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Build-BrowserHost.ps1'))
    if ($SkipWorkbenchBuild) { $buildArguments += '-SkipWorkbenchBuild' }
    & pwsh @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'The browser host did not build.' }
}
$page = if ($Page) { $Page } else { Join-Path $output 'Nendo.html' }
if (-not (Test-Path -LiteralPath $page)) { throw "No browser host page at $page." }
$page = (Resolve-Path -LiteralPath $page).Path
New-Item -ItemType Directory -Force $lane | Out-Null

# The workspace files are read, never opened or written: their bytes are dropped onto the page.
$station = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $repoRoot 'workspace/Nendo Station.nendo')))
$deck = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $repoRoot 'workspace/Deck.nendo')))
$fileUrl = { param($path) 'file:///' + ((Resolve-Path -LiteralPath $path).Path -replace '\\', '/') }
# Exported pages, made as Export -> Web page makes them (ADR-0035), from copies of the workspace files
# in a folder of this run's own: the copies are the sources the download is applied back to.
$roundTrip = Join-Path $PSScriptRoot 'WebPageRoundTrip.cs'
$sources = Join-Path $lane "sources-$runId"
New-Item -ItemType Directory -Force $sources | Out-Null
$stationSource = Join-Path $sources 'Nendo Station.nendo'
$deckSource = Join-Path $sources 'Deck.nendo'
Copy-Item -LiteralPath (Join-Path $repoRoot 'workspace/Nendo Station.nendo') -Destination $stationSource
Copy-Item -LiteralPath (Join-Path $repoRoot 'workspace/Deck.nendo') -Destination $deckSource
$stationPage = Join-Path $lane 'Nendo Station.html'
$deckPage = Join-Path $lane 'Deck.html'
foreach ($export in @(@($stationSource, $stationPage), @($deckSource, $deckPage))) {
    if (Test-Path -LiteralPath $export[1]) { Remove-Item -LiteralPath $export[1] }
    $made = & dotnet run $roundTrip -- export $export[0] $page $export[1] 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Export -> Web page failed for $($export[0]): $made" }
}
$download = Join-Path $lane "downloaded-$runId.nendo"
$pageUrl = & $fileUrl $page
$stationUrl = & $fileUrl $stationPage
$deckUrl = & $fileUrl $deckPage
$site = Join-Path $lane "site-$runId"
$server = $null
if ($Served) {
    # Published as a web host would: each page is the index.html of a folder of its own.
    foreach ($published in @(@($page, ''), @($stationPage, 'station'), @($deckPage, 'deck'))) {
        $folder = Join-Path $site $published[1]
        New-Item -ItemType Directory -Force $folder | Out-Null
        Copy-Item -LiteralPath $published[0] -Destination (Join-Path $folder 'index.html')
    }
    # The web app (ADR-0037): Station exported as Export -> Web app exports it, twice, so the lane can
    # publish the second export over the first.
    $worker = Join-Path (Split-Path -Parent $page) 'sw.js'
    if (-not (Test-Path -LiteralPath $worker)) { $worker = Join-Path $repoRoot 'src/Nendo.Workbench/web-app/sw.js' }
    $appSource = Join-Path $sources 'Web app.nendo'
    Copy-Item -LiteralPath (Join-Path $repoRoot 'workspace/Nendo Station.nendo') -Destination $appSource
    foreach ($app in @('app', 'app-v2')) {
        $made = & dotnet run $roundTrip -- export-app $appSource $page $worker (Join-Path $site $app) 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "Export -> Web app failed: $made" }
        # Between the two exports the owner changes a record the visitor will change too.
        if ($app -eq 'app') {
            $made = & dotnet run $roundTrip -- set $appSource incident incident.002 incidentTitle 'Changed by the owner' 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) { throw "Changing the web app's source failed: $made" }
        }
    }
    $siteInfo = Join-Path $lane "site-$runId.json"
    $server = Start-Process node -ArgumentList @((Join-Path $PSScriptRoot 'Serve-StaticSite.mjs'), "`"$site`"", "`"$siteInfo`"") -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 100 -and -not (Test-Path -LiteralPath $siteInfo); $i++) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $siteInfo)) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue; throw 'The static site did not start.' }
    $siteUrl = (Get-Content -LiteralPath $siteInfo -Raw | ConvertFrom-Json).url
    Remove-Item -LiteralPath $siteInfo
    $pageUrl = $siteUrl
    $stationUrl = "${siteUrl}station/"
    $deckUrl = "${siteUrl}deck/"
}
$probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-BrowserHost.mjs'))
$probe = $probe.Replace('__PAGE_URL__', $pageUrl).Replace('__STATION_BASE64__', $station).Replace('__DECK_BASE64__', $deck)
$probe = $probe.Replace('__STATION_PAGE_URL__', $stationUrl).Replace('__DECK_PAGE_URL__', $deckUrl)
$probe = $probe.Replace('__DOWNLOAD_PATH__', ($download -replace '\\', '/'))
$probePath = Join-Path $lane "probe-$runId.mjs"
[IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))

# playwright-cli writes its page snapshots into the current directory.
Push-Location $lane
try {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser $Browser | Out-Null
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
    $where = if ($Served) { "served from $pageUrl" } else { 'from disk' }
    Write-Host ("Browser host lane passed in $Browser, $where`: " + ($result.checks -join ', ') + '. Browser exceptions: ' + $result.errors.Count)

    # The exported page's download, whole, applied back to the file it was exported from.
    $checked = & dotnet run $roundTrip -- apply $stationSource $download incident incident.001 incidentSeverity incident incident.002 incidentTitle 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Apply changes from a web page failed on the exported page's download: $checked" }
    $file = ([regex]::Match($checked, '\{"integrity"[^\r\n]+\}').Value) | ConvertFrom-Json
    if ($file.integrity -ne 'ok') { throw "The exported page's download failed its integrity check: $($file.integrity)." }
    if (-not $file.applied -or @($file.leftOut).Count -ne 0) {
        throw "The exported page's changes were not applied whole: applied $($file.applied), left out: $(@($file.leftOut) -join '; ')."
    }
    if ($file.values[0] -ne 'Elevated' -or $file.values[1] -ne 'Kept across visits') {
        throw "The page's edits did not arrive in the file it was exported from: $($file.values -join ', ')."
    }
    Write-Host "The exported page's download applies back: integrity $($file.integrity), $($file.replayed) changes replayed, both edits arrived."

    if ($Served) {
        $appProbe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-WebApp.mjs'))
        $appProbe = $appProbe.Replace('__APP_URL__', "${siteUrl}app/").Replace('__PUBLISH_URL__', "${siteUrl}__publish?from=app-v2&to=app")
        $appDownload = Join-Path $lane "web-app-download-$runId.nendo"
        $appPrevious = Join-Path $lane "web-app-previous-$runId.nendo"
        $appProbe = $appProbe.Replace('__DOWNLOAD_PATH__', ($appDownload -replace '\\', '/')).Replace('__PREVIOUS_PATH__', ($appPrevious -replace '\\', '/'))
        $appProbePath = Join-Path $lane "web-app-probe-$runId.mjs"
        [IO.File]::WriteAllText($appProbePath, $appProbe, [Text.UTF8Encoding]::new($false))
        try {
            $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $appProbePath 2>&1 | Out-String
            $exitCode = $LASTEXITCODE
        }
        finally { Remove-Item -LiteralPath $appProbePath -ErrorAction SilentlyContinue }
        [IO.File]::WriteAllText((Join-Path $lane 'web-app-results.txt'), $ran, [Text.UTF8Encoding]::new($false))
        $resultLine = [regex]::Match($ran, '### Result\r?\n(\{[^\r\n]+\})')
        if ($exitCode -ne 0 -or -not $resultLine.Success) {
            $errorLine = [regex]::Match($ran, '### Error\r?\n([^\r\n]+)')
            if ($errorLine.Success) { Write-Host $errorLine.Groups[1].Value } else { Write-Host ($ran.Substring(0, [Math]::Min(2400, $ran.Length))) }
            throw 'The web app lane did not complete.'
        }
        $result = $resultLine.Groups[1].Value | ConvertFrom-Json
        if ($result.complete -ne $true) { throw 'The web app lane returned an incomplete result.' }
        Write-Host ("Web app lane passed in $Browser`: " + ($result.checks -join ', ') + '. Browser exceptions: ' + $result.errors.Count)
        try {
            # The copy carried across the republish applies back to the source it was exported from.
            $checked = & dotnet run $roundTrip -- apply $appSource $appDownload incident incident.001 incidentSeverity incident incident.002 incidentTitle 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) { throw "Apply changes failed on the web app's carried copy: $checked" }
            $file = ([regex]::Match($checked, '\{"integrity"[^\r\n]+\}').Value) | ConvertFrom-Json
            if ($file.integrity -ne 'ok' -or -not $file.applied -or $file.values[0] -ne 'Elevated' -or $file.values[1] -ne 'Changed by the owner') {
                throw "The web app's carried copy did not apply back: integrity $($file.integrity), applied $($file.applied), values $($file.values -join ', ')."
            }
            if (-not (Test-Path -LiteralPath $appPrevious) -or (Get-Item -LiteralPath $appPrevious).Length -eq 0) { throw 'Download previous copy saved nothing.' }
            Write-Host "The web app's carried copy applies back: integrity $($file.integrity), $($file.replayed) changes replayed, the visitor's edit arrived."
        }
        finally {
            foreach ($scratch in @($appDownload, $appPrevious)) { if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch } }
        }
    }
}
finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close | Out-Null
    foreach ($scratch in @($probePath, $download, $stationPage, $deckPage)) {
        if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch }
    }
    if (Test-Path -LiteralPath $sources) { Remove-Item -LiteralPath $sources -Recurse }
    if ($server) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $site) { Remove-Item -LiteralPath $site -Recurse }
    Pop-Location
}
