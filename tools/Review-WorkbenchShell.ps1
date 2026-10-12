# Drives the Workbench's shell, Use screens and Agent page against the browser preview host and
# measures what the broad review of 2026-10-10 found wrong in them (W-206): focus kept across
# redraws, menus that Escape closes on their own, the redraw hold over the breadcrumb pickers,
# the tab strip and the File menu in a narrow window, and more. Each check names its finding.
#
# It runs the Vite dev server rather than the built bundle, so a probe can reach the shell's own
# module (the redraw hold, a redraw on demand) as the page itself does: one module instance, one
# state. What it does NOT cover: the Desktop host, WebView2 or a real agent.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workbench = Join-Path $repoRoot 'src/Nendo.Workbench'
$output = Join-Path $repoRoot 'artifacts/workbench-shell'
[void][IO.Directory]::CreateDirectory($output)

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
$vite = Join-Path $workbench 'node_modules/vite/bin/vite.js'
$serverLog = Join-Path $output 'vite.log'
$server = Start-Process node -ArgumentList @($vite, '--host', '127.0.0.1', '--port', "$port", '--strictPort') -WorkingDirectory $workbench -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $output 'vite.err.log')
$url = "http://127.0.0.1:$port/"
$session = "workbench-shell-$([Guid]::NewGuid().ToString('N'))"
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($true) {
        if ($server.HasExited) { throw 'The Vite dev server exited before it answered.' }
        try { $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; break } catch { }
        if ([DateTime]::UtcNow -gt $deadline) { throw "The Vite dev server did not answer at $url." }
        Start-Sleep -Milliseconds 200
    }
    $probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-WorkbenchShell.mjs')).Replace('__WORKBENCH_URL__', $url)
    $probePath = Join-Path $output 'probe.mjs'
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'The Workbench shell measurement browser did not start.' }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    [IO.File]::WriteAllText((Join-Path $output 'browser-results.txt'), $ran, [Text.UTF8Encoding]::new($false))
    $exitCode = $LASTEXITCODE
    # The probe's own result sits under ### Result; playwright-cli exits 0 when a modal stops a probe early.
    $resultLine = [regex]::Match($ran, '### Result\r?\n(\{[^\r\n]+\})')
    if ($exitCode -ne 0 -or -not $resultLine.Success -or $ran -match '### Modal state') {
        Write-Host ($ran.Substring(0, [Math]::Min(3000, $ran.Length)))
        throw 'Workbench shell browser measurements did not complete.'
    }
    $result = $resultLine.Groups[1].Value | ConvertFrom-Json
    if ($result.complete -ne $true) { throw "Workbench shell browser measurements failed after: $($result.checks -join ', '). $($result.failure)" }
    if ($result.errors.Count -gt 0) { throw "The Workbench threw while measured: $($result.errors -join ' | ')" }
    Write-Host ('Workbench shell browser lane passed: ' + ($result.checks -join ', ') + '. Browser exceptions: 0')
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    # Vite starts esbuild as a child; the tree goes together.
    if (-not $server.HasExited) { & taskkill.exe /PID $server.Id /T /F | Out-Null }
    $server.Dispose()
}
