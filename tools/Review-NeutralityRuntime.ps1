[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $repoRoot ('artifacts/evidence/runs/review-neutrality-' + [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $evidenceRoot)
$exe = Join-Path $repoRoot 'artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe'
$portReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portReservation.Start()
$port = $portReservation.LocalEndpoint.Port
$portReservation.Stop()
$binaryRoot = Split-Path $exe
$freezeFiles = @(Get-Item $exe) + @(Get-ChildItem -LiteralPath $binaryRoot -File -Filter 'Nendo.*.dll') + @(Get-ChildItem -LiteralPath (Join-Path $binaryRoot 'Workbench') -Recurse -File)
$frozen = @($freezeFiles | Sort-Object FullName | ForEach-Object { @{ path = [IO.Path]::GetRelativePath($repoRoot, $_.FullName); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
$frozen | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'frozen-host.json')
foreach ($phase in @('create', 'reopen', 'idea', 'idea-reopen', 'decision', 'decision-reopen')) {
    $target = $null
    $reopen = $phase -eq 'reopen' -or $phase.EndsWith('-reopen')
    $fileName = if ($phase -in @('create', 'reopen')) { 'neutral-workspace.nendo' } else { $phase.Split('-')[0] + '.nendo' }
    try {
        $target = Start-Process -FilePath $exe -WorkingDirectory $binaryRoot -PassThru -WindowStyle Hidden -Environment @{
            NENDO_STARTUP_CREATE = $(if (-not $reopen) { Join-Path $evidenceRoot $fileName } else { '' })
            NENDO_STARTUP_OPEN = $(if ($reopen) { Join-Path $evidenceRoot $fileName } else { '' })
            NENDO_DESKTOP_TEST_STATE_ROOT = (Join-Path $evidenceRoot 'device-state')
            WEBVIEW2_USER_DATA_FOLDER = (Join-Path $evidenceRoot 'webview-profile')
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
            # The close button minimises to the notification area by default, and no
            # script can click a tray menu. Pin the exit this lane's teardown relies on.
            NENDO_DESKTOP_CLOSE_ACTION = 'exit'
        }
        & node (Join-Path $PSScriptRoot 'Review-NeutralityRuntime.mjs') $port $target.Id $evidenceRoot $phase
        if ($LASTEXITCODE -ne 0) { throw "Review neutrality $phase probe failed with exit code $LASTEXITCODE. Evidence root: $evidenceRoot" }
    }
    finally {
        if ($null -ne $target -and -not $target.HasExited) {
            if (-not $target.CloseMainWindow() -or -not $target.WaitForExit(15000)) {
                throw "Owned Nendo PID $($target.Id) did not close normally; no other process was stopped."
            }
        }
    }
}
foreach ($entry in $frozen) {
    if ((Get-FileHash -LiteralPath (Join-Path $repoRoot $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'Host changed during the hold-out journey.' }
}
Write-Host 'Frozen-host hashes unchanged across authoring, reshape and fresh-process reopen.'
