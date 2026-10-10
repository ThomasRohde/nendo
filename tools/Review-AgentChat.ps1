# Drives a launched agent's conversation tab in the built Workbench, against the browser preview
# host's scripted agent, and measures what the ACP review of 2026-10-10 found wrong in it: the
# level shown after a change on the Agent page (ACP-12), keyboard focus on a fold (ACP-05), where
# More opens (ACP-04), what New session keeps (ACP-02) and which tab owns the conversation (ACP-06).
#
# What it does NOT cover: a real agent program, the Desktop host or WebView2. Those are the
# Desktop tests (DesktopLaunchedAgentTests) and the owner's installed app.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $repoRoot 'artifacts/agent-chat'
[void][IO.Directory]::CreateDirectory($output)
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'src/Nendo.Workbench/dist/index.html'))) {
    throw 'The Workbench is not built. Run npm --prefix src/Nendo.Workbench run build first.'
}
$runId = [Guid]::NewGuid().ToString('N')
$infoPath = Join-Path $output "server-$runId.json"
$server = Start-Process node -ArgumentList @((Join-Path $PSScriptRoot 'Workbench-PreviewServer.mjs'), $infoPath) -WindowStyle Hidden -PassThru
$session = "agent-chat-$runId"
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $infoPath)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'The Workbench preview server did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.pid -ne $server.Id) { throw 'The Workbench preview server PID differs.' }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-AgentChat.mjs')).Replace('__WORKBENCH_URL__', $info.url)
    $probePath = Join-Path $output 'probe.mjs'
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'The agent-chat measurement browser did not start.' }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    [IO.File]::WriteAllText((Join-Path $output 'browser-results.txt'), $ran, [Text.UTF8Encoding]::new($false))
    $exitCode = $LASTEXITCODE
    # The probe ends with complete: true. playwright-cli exits 0 when a modal stops a probe early.
    $resultLine = [regex]::Match($ran, '### Result\r?\n(\{[^\r\n]+\})')
    if ($exitCode -ne 0 -or -not $resultLine.Success) { Write-Host ($ran.Substring(0, [Math]::Min(2400, $ran.Length))); throw 'Agent-chat browser measurements did not complete.' }
    $result = $resultLine.Groups[1].Value | ConvertFrom-Json
    if ($result.complete -ne $true) { throw 'Agent-chat browser measurements returned an incomplete result.' }
    Write-Host ('Agent-chat browser lane passed: ' + ($result.checks -join ', ') + '. Browser exceptions: ' + $result.errors.Count)
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $infoPath) { Remove-Item -LiteralPath $infoPath }
}
