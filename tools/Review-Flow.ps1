[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $repoRoot 'artifacts/flow'
[void][IO.Directory]::CreateDirectory($output)
& node --test tools/flow/model.test.mjs tools/flow/definition.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Flow model and definition checks failed.' }
$runId = [Guid]::NewGuid().ToString('N')
$infoPath = Join-Path $output "review-server-$runId.json"
$server = Start-Process node -ArgumentList @('tools/Graph-FixtureServer.mjs', $infoPath, '../extensions/flow') -WindowStyle Hidden -PassThru
$session = "flow-$runId"
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $infoPath)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Flow fixture server did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.pid -ne $server.Id) { throw 'Flow fixture server PID differs.' }
    $fixture = & node --input-type=module -e "import {fixture} from './tools/flow/definition.mjs';console.log(JSON.stringify(fixture()));"
    if ($LASTEXITCODE -ne 0) { throw 'Flow fixture generation failed.' }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-Flow.mjs'))
    $probe = $probe.Replace('__BROKER_URL__', $info.brokerUrl).Replace("'__FLOW_FIXTURE__'", $fixture).Replace('__OUTPUT__', $output.Replace('\', '/'))
    $probePath = Join-Path $output 'probe.mjs'
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'Flow measurement browser did not start.' }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    [IO.File]::WriteAllText((Join-Path $output 'browser-results.txt'), $ran, [Text.UTF8Encoding]::new($false))
    $exitCode = $LASTEXITCODE
    $resultLine = [regex]::Match($ran, '### Result\r?\n(\{[^\r\n]+\})')
    if ($exitCode -ne 0 -or -not $resultLine.Success) { Write-Host ($ran.Substring(0, [Math]::Min(2400, $ran.Length))); throw 'Flow browser measurements did not complete.' }
    $result = $resultLine.Groups[1].Value | ConvertFrom-Json
    if ($result.complete -ne $true) { throw 'Flow browser measurements returned an incomplete result.' }
    [IO.File]::WriteAllText((Join-Path $output 'browser-results.json'), $resultLine.Groups[1].Value, [Text.UTF8Encoding]::new($false))
    Write-Host ('Flow browser lane passed: ' + ($result.checks -join '; ') + '. Browser exceptions: ' + $result.errors.Count)
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $infoPath) { Remove-Item -LiteralPath $infoPath }
}
