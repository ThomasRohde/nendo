[CmdletBinding()]
param([string] $Executable)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root = Join-Path $repoRoot ('artifacts/evidence/runs/review-desktop-performance-' + [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $root)
$exe = if ($Executable) { (Resolve-Path -LiteralPath $Executable).Path } else { Join-Path $repoRoot 'artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe' }
$binaryRoot = Split-Path $exe
$fixtureEngine = Join-Path $binaryRoot 'Nendo.Engine.dll'
$freezeFiles = @(Get-ChildItem -LiteralPath $binaryRoot -Recurse -File)
$freezeFiles += @(Get-Item -LiteralPath @($PSCommandPath,
    (Join-Path $PSScriptRoot 'Review-Performance.ps1'),
    (Join-Path $PSScriptRoot 'Review-PerformanceRuntime.mjs'),
    (Join-Path $PSScriptRoot 'Review-PerformanceMemory.ps1'),
    (Join-Path $repoRoot 'artifacts/bin/Nendo.Engine.Tests/debug/Nendo.Engine.Tests.dll')))
$frozen = @($freezeFiles | Sort-Object FullName | ForEach-Object { @{ path=[IO.Path]::GetRelativePath($repoRoot,$_.FullName); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
$frozen | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'frozen-host.json')
$protocolHash = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'docs/design/r06-performance-qualification.md') -Algorithm SHA256).Hash.ToLowerInvariant()
$failedTargets = [Collections.Generic.List[string]]::new()
foreach ($recordCount in @(1000,10000)) {
    foreach ($revisionCount in @(1000,10000)) {
        $cell = Join-Path $root "records-$recordCount-history-$revisionCount"
        & pwsh (Join-Path $PSScriptRoot 'Review-Performance.ps1') -Mode Generate -Records $recordCount -Revisions $revisionCount -OutputRoot $cell -EngineAssembly $fixtureEngine
        if ($LASTEXITCODE -ne 0) { throw 'Native performance fixture generation failed.' }
        $reports = @()
        foreach ($iteration in 0..2) {
            $target = $null
            $reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
            $reservation.Start(); $port = $reservation.LocalEndpoint.Port; $reservation.Stop()
            try {
                $launchedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $target = Start-Process -FilePath $exe -WorkingDirectory $binaryRoot -PassThru -WindowStyle Hidden -Environment @{
                    NENDO_STARTUP_CREATE=''; NENDO_STARTUP_OPEN=(Join-Path $cell "records-$recordCount-history-$revisionCount.nendo")
                    NENDO_STARTUP_TIMING_OUTPUT=(Join-Path $cell "native-startup-$iteration.json")
                    NENDO_DEVICE_STATE_ROOT=(Join-Path $cell 'device-state'); WEBVIEW2_USER_DATA_FOLDER=(Join-Path $cell 'webview-profile')
                    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port"
                    # No script can click a tray menu; pin the exit teardown relies on.
                    NENDO_DESKTOP_CLOSE_ACTION='exit'
                }
                & node (Join-Path $PSScriptRoot 'Review-PerformanceRuntime.mjs') $port $target.Id $cell $iteration $launchedAt $revisionCount $exe
                if ($LASTEXITCODE -ne 0) { throw "Native performance iteration $iteration failed: $cell" }
                $reports += Get-Content -LiteralPath (Join-Path $cell "desktop-$iteration.json") -Raw | ConvertFrom-Json
            }
            finally {
                if ($null -ne $target -and -not $target.HasExited) {
                    if (-not $target.CloseMainWindow() -or -not $target.WaitForExit(15000)) { throw "Owned performance PID $($target.Id) did not close normally." }
                }
            }
        }
        $summary = [ordered]@{ records=$recordCount; revisions=$revisionCount; protocolSha256=$protocolHash;
            startupMilliseconds=@($reports | ForEach-Object startupMilliseconds); startupTargetPassed=(@($reports | Where-Object { $_.startupMilliseconds -gt 5000 }).Count -eq 0)
            memoryTargetPassed=(@($reports | Where-Object { -not $_.thresholds.memory }).Count -eq 0)
            initialBridgeTargetPassed=(@($reports | Where-Object { -not $_.thresholds.initialBridge }).Count -eq 0)
            executable=$exe; runtime=$reports[-1].runtime; measurement=$reports[-1]; scope='Exact executable recorded; controlled renderer input, warm/uncontrolled OS cache; installation provenance must be supplied by the caller; no human qualification' }
        $summary | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $cell 'summary.json')
        foreach ($report in $reports) {
            foreach ($threshold in $report.thresholds.PSObject.Properties) {
                if ($threshold.Value -is [bool] -and -not $threshold.Value) {
                    $failedTargets.Add("$recordCount records/$revisionCount revisions, iteration $($report.iteration): $($threshold.Name)")
                }
            }
        }
        Write-Output "Native matrix cell completed: $recordCount records/$revisionCount starting revisions."
    }
}
foreach ($entry in $frozen) {
    if ((Get-FileHash -LiteralPath (Join-Path $repoRoot $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'The host changed during performance qualification.' }
}
Write-Output "Desktop performance evidence: $root"
if ($failedTargets.Count -gt 0) {
    throw "Desktop performance targets failed; all evidence was retained: $($failedTargets -join '; ')"
}
