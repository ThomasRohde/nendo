[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $repoRoot 'artifacts/garden'
[void][IO.Directory]::CreateDirectory($output)
& node --test tools/garden/parse.test.mjs tools/garden/render.test.mjs tools/garden/sync.test.mjs tools/garden/graph.test.mjs tools/garden/definition.test.mjs tools/garden/drafts.test.mjs tools/view-kit/kit.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Garden definition, parser, renderer and sync checks failed.' }
# The fixture travels from node through this shell: read it as UTF-8, or an ellipsis arrives as mojibake.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$runId = [Guid]::NewGuid().ToString('N')
$infoPath = Join-Path $output "review-server-$runId.json"
$server = Start-Process node -ArgumentList @('tools/Graph-FixtureServer.mjs', $infoPath, '../extensions/garden') -WindowStyle Hidden -PassThru
$session = "garden-$runId"
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $infoPath)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Garden fixture server did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.pid -ne $server.Id) { throw 'Garden fixture server PID differs.' }
    $fixture = & node --input-type=module -e "import {fixture} from './tools/garden/definition.mjs';console.log(JSON.stringify(fixture()));"
    if ($LASTEXITCODE -ne 0) { throw 'Garden fixture generation failed.' }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-Garden.mjs'))
    $probe = $probe.Replace('__BROKER_URL__', $info.brokerUrl).Replace("'__GARDEN_FIXTURE__'", $fixture).Replace('__OUTPUT__', $output.Replace('\', '/'))
    $probePath = Join-Path $output 'probe.mjs'
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'Garden measurement browser did not start.' }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    [IO.File]::WriteAllText((Join-Path $output 'browser-results.txt'), $ran, [Text.UTF8Encoding]::new($false))
    $exitCode = $LASTEXITCODE
    $resultLine = [regex]::Match($ran, '### Result\r?\n(\{[^\r\n]+\})')
    if ($exitCode -ne 0 -or -not $resultLine.Success) { Write-Host ($ran.Substring(0, [Math]::Min(2400, $ran.Length))); throw 'Garden browser measurements did not complete.' }
    $result = $resultLine.Groups[1].Value | ConvertFrom-Json
    if ($result.complete -ne $true) { throw 'Garden browser measurements returned an incomplete result.' }
    [IO.File]::WriteAllText((Join-Path $output 'browser-results.json'), $resultLine.Groups[1].Value, [Text.UTF8Encoding]::new($false))
    Write-Host ('Garden browser lane passed: ' + ($result.checks -join ', ') + '. Browser exceptions: ' + $result.errors.Count)
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $infoPath) { Remove-Item -LiteralPath $infoPath }
}
