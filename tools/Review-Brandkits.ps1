[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $repoRoot 'artifacts/brandkits'
[void][IO.Directory]::CreateDirectory($output)
# Every test file of the package, by node's own glob, so a new one is never left out.
# The engine-copy test keeps Brandkits drawing slides with the engine Deck draws them with.
& node --test 'tools/brandkits/*.test.mjs' tools/deck/engine-copy.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Brandkits slide design and Deck engine copy checks failed.' }
# The fixture travels from node through this shell: read it as UTF-8, or a dash arrives as mojibake.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$runId = [Guid]::NewGuid().ToString('N')
$infoPath = Join-Path $output "review-server-$runId.json"
$server = Start-Process node -ArgumentList @('tools/Graph-FixtureServer.mjs', $infoPath, '../extensions/brandkits') -WindowStyle Hidden -PassThru
$session = "brandkits-$runId"
$rootSnapshots = Join-Path $repoRoot '.playwright-cli'
# Snapshots this run wrote there, told apart by time from any other run's.
$laneStarted = [DateTime]::UtcNow
$pushed = $false
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $infoPath)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Brandkits fixture server did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.pid -ne $server.Id) { throw 'Brandkits fixture server PID differs.' }
    $fixture = & node --input-type=module -e "import {fixture} from './tools/brandkits/definition.mjs';console.log(JSON.stringify(fixture()));"
    if ($LASTEXITCODE -ne 0) { throw 'Brandkits fixture generation failed.' }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-Brandkits.mjs'))
    $probe = $probe.Replace('__BROKER_URL__', $info.brokerUrl).Replace("'__BRANDKITS_FIXTURE__'", $fixture)
    # Named for the run and removed after it, so two runs never share one probe file.
    $probePath = Join-Path $output "probe-$runId.mjs"
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    # playwright-cli writes its page snapshots into the current directory, which is the
    # repository root under Test-Production; this lane's output folder is where they belong.
    Push-Location $output
    $pushed = $true
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'Brandkits measurement browser did not start.' }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    [IO.File]::WriteAllText((Join-Path $output 'browser-results.txt'), $ran, [Text.UTF8Encoding]::new($false))
    $exitCode = $LASTEXITCODE
    $resultLine = [regex]::Match($ran, '### Result\r?\n(\{[^\r\n]+\})')
    if ($exitCode -ne 0 -or -not $resultLine.Success) { Write-Host ($ran.Substring(0, [Math]::Min(2400, $ran.Length))); throw 'Brandkits browser measurements did not complete.' }
    $result = $resultLine.Groups[1].Value | ConvertFrom-Json
    if ($result.complete -ne $true) { throw 'Brandkits browser measurements returned an incomplete result.' }
    [IO.File]::WriteAllText((Join-Path $output 'browser-results.json'), $resultLine.Groups[1].Value, [Text.UTF8Encoding]::new($false))
    $strays = @(if (Test-Path -LiteralPath $rootSnapshots) { Get-ChildItem -LiteralPath $rootSnapshots -File | Where-Object { $_.CreationTimeUtc -ge $laneStarted } })
    if ($strays.Count -gt 0) { throw "playwright-cli wrote $($strays.Count) snapshot file(s) into the repository root instead of ${output}: $(($strays | ForEach-Object Name) -join ', ')" }
    Write-Host ('Brandkits browser lane passed: ' + ($result.checks -join ', ') + '. Browser exceptions: ' + $result.errors.Count)
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $infoPath) { Remove-Item -LiteralPath $infoPath }
    $runProbe = Join-Path $output "probe-$runId.mjs"
    if (Test-Path -LiteralPath $runProbe) { Remove-Item -LiteralPath $runProbe }
    if ($pushed) { Pop-Location }
}
