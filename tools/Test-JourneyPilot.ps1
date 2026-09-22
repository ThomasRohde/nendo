[CmdletBinding()]
param([Parameter(Mandatory)][string] $Executable)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Executable).Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $repoRoot ('artifacts/evidence/runs/p5-runtime-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $evidenceRoot)
$reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$reservation.Start()
$port = $reservation.LocalEndpoint.Port
$reservation.Stop()
$frozen = @(Get-ChildItem -LiteralPath (Split-Path $exe) -Recurse -File | ForEach-Object { @{ path = $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash } })
foreach ($phase in @('create', 'reopen')) {
    $target = $null
    try {
        $target = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru -Environment @{
            NENDO_STARTUP_CREATE = $(if ($phase -eq 'create') { Join-Path $evidenceRoot 'pilot.nendo' } else { '' })
            NENDO_STARTUP_OPEN = $(if ($phase -eq 'reopen') { Join-Path $evidenceRoot 'pilot.nendo' } else { '' })
            WEBVIEW2_USER_DATA_FOLDER = (Join-Path $evidenceRoot 'webview-profile')
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
            # The close button minimises to the notification area by default, and no
            # script can click a tray menu. Pin the exit this lane's teardown relies on.
            NENDO_DESKTOP_CLOSE_ACTION = 'exit'
        }
        & node (Join-Path $PSScriptRoot 'Journey-Pilot.mjs') $port $target.Id $evidenceRoot $phase
        if ($LASTEXITCODE -ne 0) { throw "Pilot $phase failed. Evidence: $evidenceRoot" }
    } finally {
        if ($null -ne $target -and -not $target.HasExited) {
            if (-not $target.CloseMainWindow() -or -not $target.WaitForExit(15000)) { throw "Owned pilot PID $($target.Id) did not close normally." }
        }
    }
}

# ADR-0008 stage S7. A second file, seeded with calculations and one automatic
# action, driven through the same real host. Its device-state root is isolated:
# approving writes durable device trust, and this lane must never reach into the
# owner's.
$behaviourFile = Join-Path $evidenceRoot 'behaviour.nendo'
$deviceStateRoot = Join-Path $evidenceRoot 'device-state'
& (Join-Path $PSScriptRoot 'Runtime-BehaviourFixture.ps1') -Path $behaviourFile
if (-not $?) { throw "Behaviour fixture seeding failed. Evidence: $evidenceRoot" }
foreach ($phase in @('approve', 'remember')) {
    $target = $null
    try {
        $target = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru -Environment @{
            NENDO_STARTUP_OPEN = $behaviourFile
            NENDO_DEVICE_STATE_ROOT = $deviceStateRoot
            WEBVIEW2_USER_DATA_FOLDER = (Join-Path $evidenceRoot 'behaviour-webview-profile')
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
            # The close button minimises to the notification area by default, and no
            # script can click a tray menu. Pin the exit this lane's teardown relies on.
            NENDO_DESKTOP_CLOSE_ACTION = 'exit'
        }
        & node (Join-Path $PSScriptRoot 'Journey-Behaviour.mjs') $port $target.Id $evidenceRoot $phase
        if ($LASTEXITCODE -ne 0) { throw "Behaviour $phase failed. Evidence: $evidenceRoot" }
    } finally {
        if ($null -ne $target -and -not $target.HasExited) {
            if (-not $target.CloseMainWindow() -or -not $target.WaitForExit(15000)) { throw "Owned behaviour PID $($target.Id) did not close normally." }
        }
    }
}
foreach ($file in $frozen) { if ((Get-FileHash -LiteralPath $file.path).Hash -ne $file.sha256) { throw "Payload changed: $($file.path)" } }
@{ executable = $exe; files = $frozen; result = 'passed'; limitation = 'Current Windows user with existing WebView2; not a clean-machine or human test.' } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'runtime.json')
Write-Output "Pilot runtime evidence: $evidenceRoot"
