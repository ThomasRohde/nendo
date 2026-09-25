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
$infoPath = Join-Path $output "graph-server-$run.json"
$probePath = Join-Path $output "graph-probe-$run.mjs"
$serverScript = Join-Path $PSScriptRoot 'Graph-FixtureServer.mjs'
$server = Start-Process node -ArgumentList @("`"$serverScript`"", "`"$infoPath`"", '../extensions/dependency-graph') -WindowStyle Hidden -PassThru
$session = "graph-$run"
Push-Location $output
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $infoPath)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Graph fixture server did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.pid -ne $server.Id) { throw 'Graph fixture process identity differs.' }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-DependencyGraph.mjs'))
    $probe = $probe.Replace("'__NENDO_REPOSITORY__'", ($repoRoot.Replace('\', '/') | ConvertTo-Json -Compress)).Replace('__BROKER_URL__', $info.brokerUrl)
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'Graph browser did not start.' }
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath
    if ($LASTEXITCODE -ne 0) { throw 'Graph browser measurements failed.' }
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $infoPath) { Remove-Item -LiteralPath $infoPath }
    if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath }
    Pop-Location
}
