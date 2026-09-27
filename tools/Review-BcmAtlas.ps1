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
# The package's own tests: hierarchy and level rules, the frozen lab coordinates, module syntax.
$tests = @('model.test.mjs', 'syntax.test.mjs', 'layout-parity.test.mjs') | ForEach-Object { Join-Path $PSScriptRoot "bcm-atlas/$_" }
& node --experimental-vm-modules --test @tests
if ($LASTEXITCODE -ne 0) { throw 'Capability Atlas node tests failed.' }
# The shipped Northstar model, generated as the live file was: 635 capabilities and their links.
$northstar = [Uri]::new((Join-Path $PSScriptRoot 'bcm-atlas/northstar.mjs')).AbsoluteUri
$run = [Guid]::NewGuid().ToString('N')
$modelPath = Join-Path $output "bcm-atlas-model-$run.json"
& node --input-type=module -e "import fs from 'node:fs'; import {northstarModel} from '$northstar'; fs.writeFileSync(process.argv[1], JSON.stringify(northstarModel()));" $modelPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $modelPath)) { throw 'The Northstar model could not be generated.' }
$model = [IO.File]::ReadAllText($modelPath)
Remove-Item -LiteralPath $modelPath
$infoPath = Join-Path $output "bcm-atlas-server-$run.json"
$probePath = Join-Path $output "bcm-atlas-probe-$run.mjs"
$serverScript = Join-Path $PSScriptRoot 'Graph-FixtureServer.mjs'
$server = Start-Process node -ArgumentList @("`"$serverScript`"", "`"$infoPath`"", '../extensions/bcm-atlas') -WindowStyle Hidden -PassThru
$session = "bcm-atlas-$run"
Push-Location $output
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $infoPath)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Capability Atlas fixture server did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.pid -ne $server.Id) { throw 'Capability Atlas fixture process identity differs.' }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-BcmAtlas.mjs'))
    $probe = $probe.Replace("'__NENDO_REPOSITORY__'", ($repoRoot.Replace('\', '/') | ConvertTo-Json -Compress)).Replace('__BROKER_URL__', $info.brokerUrl).Replace("'__BCM_FIXTURE__'", $model)
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'Capability Atlas browser did not start.' }
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath
    if ($LASTEXITCODE -ne 0) { throw 'Capability Atlas browser measurements failed.' }
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $infoPath) { Remove-Item -LiteralPath $infoPath }
    if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath }
    Pop-Location
}
