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
$run = [Guid]::NewGuid().ToString('N')
$infoPath = Join-Path $output "gantt-server-$run.json"
$probePath = Join-Path $output "gantt-probe-$run.mjs"
$serverScript = Join-Path $PSScriptRoot 'Graph-FixtureServer.mjs'
# The view kit's own tests, that every package carries the kit byte for byte, and that a
# view stylesheet claiming the Workbench's tokens holds their values.
& node --test (Join-Path $PSScriptRoot 'view-kit/kit.test.mjs') (Join-Path $PSScriptRoot 'view-kit/tokens.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'View kit tests failed.' }
$server = Start-Process node -ArgumentList @("`"$serverScript`"", "`"$infoPath`"", '../extensions/gantt') -WindowStyle Hidden -PassThru
$session = "gantt-$run"
Push-Location $output
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $infoPath)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Gantt fixture server did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.pid -ne $server.Id) { throw 'Gantt fixture process identity differs.' }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-Gantt.mjs'))
    $probe = $probe.Replace("'__NENDO_REPOSITORY__'", ($repoRoot.Replace('\', '/') | ConvertTo-Json -Compress)).Replace('__BROKER_URL__', $info.brokerUrl)
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'Gantt browser did not start.' }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    Write-Host $ran
    # run-code ends early and exits 0 when a dialog opens (a label that became markup and opened
    # an alert, say), so an exit code alone would pass a probe that stopped part-way.
    # The probe's source is echoed too, so its last word counts only as the run's own result.
    if ($exitCode -ne 0 -or $ran.Contains('### Modal state') -or $ran -notmatch '### Result\r?\n"gantt ok ') {
        throw 'Gantt browser measurements did not complete.'
    }
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $infoPath) { Remove-Item -LiteralPath $infoPath }
    if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath }
    Pop-Location
}
