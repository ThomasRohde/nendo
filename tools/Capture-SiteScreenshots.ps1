[CmdletBinding()]
param(
    # The debug build by default, as every other runtime lane does.
    [string] $Executable = '',
    # The file the shots are taken of. Nendo Station is the fourth reference
    # application and is rebuilt by tools/Build-NendoStation.mjs, so it is the
    # one demo file whose shape is reproducible.
    [string] $SourceFile = '',
    # The pictures reference file, taken in a second run with the folder of
    # pictures beside it; the names starting "pictures-" in the capture set are its.
    [string] $PicturesFile = '',
    [string] $OutputDirectory = '',
    # The layout size the page is rendered at, and the device pixel ratio it is
    # rendered with. The image is Width x Scale by Height x Scale.
    [int] $Width = 1600,
    [int] $Height = 1000,
    [ValidateRange(1, 3)][int] $Scale = 2,
    # After a complete run, replace the site's committed captures with this run's.
    # The capture script fails unless it took every name in site/src/capture-set.json
    # in both themes, so the site never mixes two runs.
    [switch] $UpdateSite
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exe = if ($Executable -ne '') { [IO.Path]::GetFullPath($Executable) } else { Join-Path $repoRoot 'artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "No Nendo.Desktop.exe at $exe. Build the debug configuration or pass -Executable." }
$source = if ($SourceFile -ne '') { [IO.Path]::GetFullPath($SourceFile) } else { Join-Path $repoRoot 'workspace/Nendo Station.nendo' }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "No .nendo file at $source." }
$output = if ($OutputDirectory -ne '') { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repoRoot 'artifacts/site-screenshots' }
$pictures = if ($PicturesFile -ne '') { [IO.Path]::GetFullPath($PicturesFile) } else { Join-Path $repoRoot 'workspace/Herbarium.nendo' }
if (-not (Test-Path -LiteralPath $pictures -PathType Leaf)) { throw "No .nendo file at $pictures." }

if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
[void] (New-Item -ItemType Directory -Path $output)

Add-Type -Namespace NendoCapture -Name Window -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
'@
. (Join-Path $PSScriptRoot 'Lane-NativeHost.ps1')

function Invoke-Capture([string] $sourcePath, [string] $set) {
$runRoot = Join-Path $repoRoot ('artifacts/site-screenshots-run-' + [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $runRoot)

# The real file is write-owned by whatever Nendo has it open, and these shots are
# not worth touching the owner's data for. Take them of a copy, with the folder of
# pictures a file links beside it, as it is beside the original.
$workingFile = Join-Path $runRoot ([IO.Path]::GetFileName($sourcePath))
Copy-Item -LiteralPath $sourcePath -Destination $workingFile
$linked = Join-Path (Split-Path $sourcePath) ([IO.Path]::GetFileNameWithoutExtension($sourcePath) + ' pictures')
if (Test-Path -LiteralPath $linked -PathType Container) { Copy-Item -LiteralPath $linked -Destination $runRoot -Recurse }

$portReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portReservation.Start()
$port = $portReservation.LocalEndpoint.Port
$portReservation.Stop()

$target = $null
$succeeded = $false
$env:NENDO_RUNTIME_EXPECTED_EXECUTABLE = $exe
try {
    # Deliberately NOT -WindowStyle Hidden. A hidden WebView2 stops producing frames,
    # and Page.captureScreenshot then returns the last one it drew: the first run this
    # way wrote four byte-identical Studio shots of four different screens.
    $target = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru -Environment @{
        NENDO_STARTUP_CREATE = ''
        NENDO_STARTUP_OPEN = $workingFile
        # A private device-state root and WebView2 profile: the run never reads or
        # writes the owner's theme, consents or recent files.
        NENDO_DEVICE_STATE_ROOT = (Join-Path $runRoot 'device-state')
        NENDO_DESKTOP_TEST_STATE_ROOT = (Join-Path $runRoot 'device-state')
        WEBVIEW2_USER_DATA_FOLDER = (Join-Path $runRoot 'webview-profile')
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
        # The close button minimises to the notification area by default, and no
        # script can click a tray menu. Pin the exit this lane's teardown relies on.
        NENDO_DESKTOP_CLOSE_ACTION = 'exit'
    }

    # The device-metrics override decides the image size; the window is sized to the
    # same layout so the host is not laying out at one size and rendering at another.
    $settle = [DateTimeOffset]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 150
        $target.Refresh()
        $handle = $target.MainWindowHandle
    } while ($handle -eq [IntPtr]::Zero -and [DateTimeOffset]::UtcNow -lt $settle)
    if ($handle -eq [IntPtr]::Zero) { throw 'The owned Nendo window never appeared.' }
    [void] [NendoCapture.Window]::ShowWindow($handle, 1) # SW_SHOWNORMAL
    # 6 = SWP_NOMOVE | SWP_NOZORDER.
    if (-not [NendoCapture.Window]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $Width, $Height, 6)) { throw "Window resize to $Width x $Height failed." }
    [void] [NendoCapture.Window]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 900

    & node (Join-Path $PSScriptRoot 'Capture-SiteScreenshots.mjs') $port $target.Id $output $Width $Height $Scale $set
    if ($LASTEXITCODE -ne 0) { throw "Site screenshot capture failed with exit code $LASTEXITCODE. Output: $output" }
    $succeeded = $true
}
finally {
    Stop-OwnedNendo $target $succeeded
    # The run root holds a copy of the demo file, a WebView2 profile and a device
    # state root. None of it is evidence; leaving it turns artifacts/ into ballast.
    if (Test-Path -LiteralPath $runRoot) { Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
}

Invoke-Capture $source 'site'
Invoke-Capture $pictures 'pictures'
Write-Host "Captured $(@(Get-ChildItem -LiteralPath $output -Filter *.png).Count) screenshot(s) into $output"
if ($UpdateSite) {
    $siteShots = Join-Path $repoRoot 'site/src/assets/screenshots'
    $names = (Get-Content -LiteralPath (Join-Path $repoRoot 'site/src/capture-set.json') -Raw | ConvertFrom-Json).names
    $files = foreach ($name in $names) { foreach ($theme in 'light', 'dark') { "$name-$theme.png" } }
    foreach ($file in $files) {
        if (-not (Test-Path -LiteralPath (Join-Path $output $file) -PathType Leaf)) { throw "The run has no $file, so the site's captures were left as they were." }
    }
    Get-ChildItem -LiteralPath $siteShots -Filter *.png | Remove-Item
    foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $output $file) -Destination (Join-Path $siteShots $file) }
    Write-Host "Replaced the site's captures with $(@($files).Count) file(s) in $siteShots. Rebuild the site with tools/Test-Site.ps1."
}
