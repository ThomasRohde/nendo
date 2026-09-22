[CmdletBinding()]
param([string] $Executable = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $repoRoot ('artifacts/extension-dialogs-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($output)
$exe = if ($Executable) { [IO.Path]::GetFullPath($Executable) } else { Join-Path $repoRoot 'artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe' }
$reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$reservation.Start(); $port = $reservation.LocalEndpoint.Port; $reservation.Stop()
$target = $null
$previousExpected = $env:NENDO_RUNTIME_EXPECTED_EXECUTABLE
$env:NENDO_RUNTIME_EXPECTED_EXECUTABLE = $exe
try {
    $target = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru -Environment @{
        NENDO_STARTUP_CREATE = (Join-Path $output 'fixture.nendo'); NENDO_STARTUP_OPEN = ''
        NENDO_DEVICE_STATE_ROOT = (Join-Path $output 'device-state'); NENDO_NATIVE_DIAGNOSTICS = '1'
        WEBVIEW2_USER_DATA_FOLDER = (Join-Path $output 'webview')
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
        NENDO_DESKTOP_CLOSE_ACTION = 'exit'
    }
    & node (Join-Path $PSScriptRoot 'Review-ExtensionDialogs.mjs') $port $target.Id $output
    if ($LASTEXITCODE -ne 0) { throw "Extension dialog measurements failed. See $output" }
    Write-Output "Native dialog measurements passed: $output"
} finally {
    if ($null -ne $target -and -not $target.HasExited) {
        if (-not $target.CloseMainWindow() -or -not $target.WaitForExit(10000)) { $target.Kill($true) }
    }
    $env:NENDO_RUNTIME_EXPECTED_EXECUTABLE = $previousExpected
}
