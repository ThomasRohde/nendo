# ADR-0008 blackbox gate. Drives the real WinUI apphost with its own file, WebView2
# profile and device-state root, and lets an external MCP client author calculations
# and an automatic action from an empty file — then checks what it still cannot do.
[CmdletBinding()]
param([Parameter(Mandatory)][string] $Executable)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Executable).Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $repoRoot ('artifacts/evidence/runs/p7-behaviour-gate-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $evidenceRoot)
$reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$reservation.Start()
$port = $reservation.LocalEndpoint.Port
$reservation.Stop()
$frozen = @(Get-ChildItem -LiteralPath (Split-Path $exe) -Recurse -File | ForEach-Object { @{ path = $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash } })
foreach ($phase in @('author', 'reopen')) {
    $target = $null
    try {
        # The device-state root is isolated because this gate approves a file's
        # automatic actions. That approval is durable device trust, and the lane
        # must never reach into the owner's.
        $target = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru -Environment @{
            NENDO_STARTUP_CREATE = $(if ($phase -eq 'author') { Join-Path $evidenceRoot 'behaviour-gate.nendo' } else { '' })
            NENDO_STARTUP_OPEN = $(if ($phase -eq 'reopen') { Join-Path $evidenceRoot 'behaviour-gate.nendo' } else { '' })
            NENDO_DEVICE_STATE_ROOT = (Join-Path $evidenceRoot 'device-state')
            WEBVIEW2_USER_DATA_FOLDER = (Join-Path $evidenceRoot 'webview-profile')
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
            # The close button minimises to the notification area by default, and no
            # script can click a tray menu. Pin the exit this lane's teardown relies on.
            NENDO_DESKTOP_CLOSE_ACTION = 'exit'
        }
        & node (Join-Path $PSScriptRoot 'Gate-BehaviourAuthoring.mjs') $port $target.Id $evidenceRoot $phase
        if ($LASTEXITCODE -ne 0) { throw "Behaviour authoring gate $phase failed. Evidence: $evidenceRoot" }
    } finally {
        if ($null -ne $target -and -not $target.HasExited) {
            if (-not $target.CloseMainWindow() -or -not $target.WaitForExit(15000)) { throw "Owned pilot PID $($target.Id) did not close normally." }
        }
    }
}
foreach ($file in $frozen) { if ((Get-FileHash -LiteralPath $file.path).Hash -ne $file.sha256) { throw "Payload changed: $($file.path)" } }
@{ executable = $exe; files = $frozen; result = 'passed'
   limitation = 'Current Windows user with existing WebView2; not a clean-machine, human or accessibility test.' } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'runtime.json')
Write-Output "ADR-0008 behaviour gate evidence: $evidenceRoot"
