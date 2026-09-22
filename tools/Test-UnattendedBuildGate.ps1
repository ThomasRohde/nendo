[CmdletBinding()]
param([Parameter(Mandatory)][string] $Executable)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Executable).Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $repoRoot ('artifacts/evidence/runs/unattended-gate-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $evidenceRoot)
$reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$reservation.Start()
$port = $reservation.LocalEndpoint.Port
$reservation.Stop()
$target = $null
try {
    $target = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru -Environment @{
        NENDO_STARTUP_CREATE = (Join-Path $evidenceRoot 'reading-log.nendo')
        WEBVIEW2_USER_DATA_FOLDER = (Join-Path $evidenceRoot 'webview-profile')
        # A device-state root of its own, so the consent this lane records on the
        # owner's behalf is written here and never into the owner's grant document.
        NENDO_DEVICE_STATE_ROOT = (Join-Path $evidenceRoot 'device-state')
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
        NENDO_DESKTOP_CLOSE_ACTION = 'exit'
    }
    & node (Join-Path $PSScriptRoot 'Gate-UnattendedBuild.mjs') $port $target.Id $evidenceRoot
    if ($LASTEXITCODE -ne 0) { throw "Unattended build gate failed. Evidence: $evidenceRoot" }
} finally {
    if ($null -ne $target -and -not $target.HasExited) {
        if (-not $target.CloseMainWindow() -or -not $target.WaitForExit(15000)) { throw "Owned pilot PID $($target.Id) did not close normally." }
    }
}
Write-Output "Unattended build gate evidence: $evidenceRoot"
