[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$siteRoot = Join-Path $repoRoot 'site'
$output = Join-Path $repoRoot 'artifacts/site-search'
[void][IO.Directory]::CreateDirectory($output)
if (-not (Test-Path -LiteralPath (Join-Path $siteRoot 'dist/pagefind/pagefind.js'))) { throw 'Build the site before measuring its documentation search.' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$run = [Guid]::NewGuid().ToString('N')
$probePath = Join-Path $output "probe-$run.mjs"
$url = "http://127.0.0.1:$port"
$probe = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Gate-SiteSearch.mjs')).Replace('__SITE_URL__', $url)
[IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
# --ignore-lock keeps this task-owned preview in the foreground. Astro otherwise
# detects an agent and detaches a daemon that survives the owned process handle.
$server = Start-Process node -ArgumentList @('node_modules/astro/bin/astro.mjs', 'preview', '--ignore-lock', '--host', '127.0.0.1', '--port', $port) -WorkingDirectory $siteRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output "server-$run.log") -RedirectStandardError (Join-Path $output "server-$run.err")
$session = "site-search-$run"
Push-Location $output
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ($true) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'The built site preview did not start.' }
        try { $null = Invoke-WebRequest "$url/nendo/docs/getting-started" -TimeoutSec 1; break } catch { Start-Sleep -Milliseconds 100 }
    }
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge
    if ($LASTEXITCODE -ne 0) { throw 'The site search browser did not start.' }
    $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probePath 2>&1 | Out-String
    Write-Host $ran
    if ($LASTEXITCODE -ne 0 -or $ran -notmatch '\\?"complete\\?":\s*true') { throw 'Site search geometry and click measurements did not complete.' }
} finally {
    & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
    $server.Dispose()
    if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath }
    Pop-Location
}
