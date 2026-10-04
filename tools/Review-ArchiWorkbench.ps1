[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $repoRoot 'artifacts/extension-runtime-results'
[void][IO.Directory]::CreateDirectory($output)
# The view runs the real window.nendo, which the Workbench build writes; build it when it is missing.
$api = Join-Path $repoRoot 'src/Nendo.Workbench/dist/_nendo/api.js'
if (-not (Test-Path -LiteralPath $api)) {
    & npm.cmd --prefix (Join-Path $repoRoot 'src/Nendo.Workbench') run build
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $api)) { throw 'The view API could not be built: npm --prefix src/Nendo.Workbench run build failed.' }
}
# The workbench's rules over Archisurance (W-109), its validator against archi-online's (W-117), its Analysis and Visualiser against archi-online's (W-118), its .archimate mapping (W-120), and the kit it carries byte for byte.
& node --test (Join-Path $PSScriptRoot 'archi/model.test.mjs') (Join-Path $PSScriptRoot 'archi/canvas.test.mjs') (Join-Path $PSScriptRoot 'archi/view.test.mjs') (Join-Path $PSScriptRoot 'archi/validation.test.mjs') (Join-Path $PSScriptRoot 'archi/analysis.test.mjs') (Join-Path $PSScriptRoot 'archi/definition.test.mjs') (Join-Path $PSScriptRoot 'archi/io.test.mjs') (Join-Path $PSScriptRoot 'archi/automation.test.mjs') (Join-Path $PSScriptRoot 'view-kit/kit.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Archi workbench node tests failed.' }
$run = [Guid]::NewGuid().ToString('N')
$fixtureModule = [Uri]::new((Join-Path $PSScriptRoot 'archi/fixtures.mjs')).AbsoluteUri
$fixturePath = Join-Path $output "archi-fixture-$run.json"
$galleryPath = Join-Path $output "archi-gallery-$run.json"
& node --input-type=module -e "import fs from 'node:fs'; import {archiFixture, galleryFixture} from '$fixtureModule'; fs.writeFileSync(process.argv[1], JSON.stringify(archiFixture())); fs.writeFileSync(process.argv[2], JSON.stringify(galleryFixture()));" $fixturePath $galleryPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fixturePath) -or -not (Test-Path -LiteralPath $galleryPath)) { throw 'The Archi fixtures could not be generated.' }
$fixture = [IO.File]::ReadAllText($fixturePath)
$gallery = [IO.File]::ReadAllText($galleryPath)
Remove-Item -LiteralPath $fixturePath, $galleryPath
$infoPath = Join-Path $output "archi-server-$run.json"
$probePath = Join-Path $output "archi-probe-$run.mjs"
$serverScript = Join-Path $PSScriptRoot 'Graph-FixtureServer.mjs'
$server = Start-Process node -ArgumentList @("`"$serverScript`"", "`"$infoPath`"", '../extensions/archi') -WindowStyle Hidden -PassThru
$session = "archi-$run"
Push-Location $output
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $infoPath)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Archi fixture server did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.pid -ne $server.Id) { throw 'Archi fixture process identity differs.' }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-ArchiWorkbench.mjs'))
    $probe = $probe.Replace('__BROKER_URL__', $info.brokerUrl).Replace("'__ARCHI_FIXTURE__'", $fixture).Replace("'__ARCHI_GALLERY__'", $gallery)
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'Archi browser did not start.' }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    Write-Host $ran
    if ($LASTEXITCODE -ne 0) { throw 'Archi workbench browser measurements failed.' }
    # The CLI ends a probe early when a native dialog or file chooser opens, and still exits 0; the
    # probe's own last word is the only sign that it measured everything (W-120).
    if ($ran -notmatch '\\?"complete\\?":\s*true') { throw 'The Archi workbench probe did not run to its end, so it measured only part of the workbench.' }
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $infoPath) { Remove-Item -LiteralPath $infoPath }
    if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath }
    Pop-Location
}
