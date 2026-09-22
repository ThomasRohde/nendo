[CmdletBinding()]
param(
    # The debug build by default; the published payload to prove the scenario on
    # the bytes that become the installer, as Test-AgentAuthoringGate.ps1 does.
    [string] $Executable = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $repoRoot ('artifacts/evidence/runs/review-outcomes-' + [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $evidenceRoot)
$exe = if ($Executable -ne '') { [IO.Path]::GetFullPath($Executable) } else { Join-Path $repoRoot 'artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "No Nendo.Desktop.exe at $exe. Build the debug configuration or pass -Executable." }
$portReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portReservation.Start()
$port = $portReservation.LocalEndpoint.Port
$portReservation.Stop()
$target = $null
# The native dialog helpers drive only the executable they are told is owned, and
# refuse any other; on the published payload that refusal left a modal dialog open
# and the lane's own window unclosable.
$env:NENDO_RUNTIME_EXPECTED_EXECUTABLE = $exe
try {
    $target = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru -WindowStyle Hidden -Environment @{
        NENDO_STARTUP_CREATE = (Join-Path $evidenceRoot 'outcome-workspace.nendo')
        NENDO_STARTUP_OPEN = ''
        NENDO_DESKTOP_TEST_STATE_ROOT = (Join-Path $evidenceRoot 'device-state')
        WEBVIEW2_USER_DATA_FOLDER = (Join-Path $evidenceRoot 'webview-profile')
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
        # The close button minimises to the notification area by default, and no
        # script can click a tray menu. Pin the exit this lane's teardown relies on.
        NENDO_DESKTOP_CLOSE_ACTION = 'exit'
    }
    & node (Join-Path $PSScriptRoot 'Review-OutcomeRuntime.mjs') $port $target.Id $evidenceRoot
    if ($LASTEXITCODE -ne 0) { throw "Review outcome runtime probe failed with exit code $LASTEXITCODE. Evidence root: $evidenceRoot" }
}
finally {
    if ($null -ne $target -and -not $target.HasExited) {
        if (-not $target.CloseMainWindow() -or -not $target.WaitForExit(15000)) {
            # A failure with a native dialog still open blocks the close. The process is
            # this lane's own, on this run's scratch file; left alive it holds every pipe
            # a caller gave it and the caller waits forever. Stop it and say so, without
            # replacing the failure that got here.
            $target.Kill($true)
            Write-Warning "Owned Nendo PID $($target.Id) did not close normally and was stopped; no other process was touched."
        }
    }
}
