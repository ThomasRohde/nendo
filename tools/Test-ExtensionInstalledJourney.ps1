# The native custom-view journey, run against Nendo as setup installs it rather than as
# the build leaves it. The source journey launches artifacts/bin; this lane installs the
# published payload through the same Invoke-NendoSetup.ps1 the installer bundles, into a
# root of this run's own, and points DesktopExtensionJourneyTests at the installed
# executable. What that adds over the source run: the installed layout, the installed
# ExtensionHost helper and the installed graph path are the ones exercised.
#
# It never touches the owner's installation, file association or Start Menu, for the
# reasons Test-NendoSetupIsolated.ps1 gives. The NSIS wrapper stays outside it.
[CmdletBinding()]
param(
    [string] $PilotRoot = 'artifacts/build/publish',
    # Keep the installed root after a pass, to inspect it. Pruned by default: it is a copy
    # of an already hash-checked payload, not evidence.
    [switch] $KeepInstall)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pilot = (Resolve-Path -LiteralPath (Join-Path $repoRoot $PilotRoot)).Path
$payload = Join-Path $pilot 'payload'
$inventory = Join-Path $pilot 'nendo-install.json'
$manifest = Get-Content -LiteralPath (Join-Path $pilot 'manifest.json') -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $payload)) { throw "No published payload at $payload. Run Publish-NendoPayload.ps1 first." }
if (-not (Test-Path -LiteralPath $inventory)) { throw "No payload inventory at $inventory. Run Build-NendoInstaller.ps1 first." }
$setup = Join-Path $PSScriptRoot 'Invoke-NendoSetup.ps1'

$evidenceRoot = Join-Path $repoRoot ('artifacts/evidence/runs/w007-installed-journey-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $evidenceRoot)
$installRoot = Join-Path $evidenceRoot 'install'
$classesRoot = "HKCU:\Software\Nendo-Installed-Journey\$([Guid]::NewGuid().ToString('N'))\Classes"
$startMenuRoot = Join-Path $evidenceRoot 'start-menu'
$ownerRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs/Nendo'
if ([IO.Path]::GetFullPath($installRoot).StartsWith([IO.Path]::GetFullPath($ownerRoot), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The journey root resolved inside the owner installation.'
}

function Invoke-Setup([string] $Mode, [string[]] $Extra = @()) {
    $log = Join-Path $evidenceRoot "setup-$($Mode.ToLowerInvariant()).log"
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $setup,
        '-Mode', $Mode, '-InstallRoot', $installRoot, '-ClassesRoot', $classesRoot, '-StartMenuRoot', $startMenuRoot) + $Extra
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait `
        -RedirectStandardOutput $log -RedirectStandardError "$log.errors"
    if ($process.ExitCode -ne 0) {
        $tail = @(Get-Content -LiteralPath $log, "$log.errors" -ErrorAction SilentlyContinue | Select-Object -Last 12)
        throw "Setup $Mode failed with exit code $($process.ExitCode). Log: $log`n$($tail -join "`n")"
    }
}

# Staged the way the installer stages it: published files, inventory, bundled setup.
$staged = Join-Path $evidenceRoot 'staged-payload'
Copy-Item -LiteralPath $payload -Destination $staged -Recurse
Copy-Item -LiteralPath $inventory -Destination (Join-Path $staged 'nendo-install.json')
Copy-Item -LiteralPath $setup -Destination (Join-Path $staged 'Nendo.Setup.ps1')
$installed = $false
$outcome = 'failed'
try {
    Invoke-Setup 'Install' @('-PayloadRoot', $staged, '-MovePayload')
    $installed = $true
    # What runs must be what was published, byte for byte, or the journey measures
    # something else.
    foreach ($entry in $manifest.files) {
        $file = Join-Path $installRoot $entry.path
        if (-not (Test-Path -LiteralPath $file)) { throw "Missing installed file: $($entry.path)" }
        if ((Get-FileHash -LiteralPath $file).Hash -ne $entry.sha256) { throw "Installed bytes differ: $($entry.path)" }
    }
    $executable = Join-Path $installRoot 'Nendo.Desktop.exe'
    $env:NENDO_EXTENSION_JOURNEY_EXECUTABLE = $executable
    try {
        $log = Join-Path $evidenceRoot 'journey-test.log'
        dotnet test (Join-Path $repoRoot 'tests/Nendo.Desktop.Tests/Nendo.Desktop.Tests.csproj') --no-restore `
            --filter 'FullyQualifiedName~NativeConsentGraphAndStudioJourneyUsesOnlyAnIsolatedProfile' *> $log
        $exit = $LASTEXITCODE
    }
    finally { Remove-Item Env:NENDO_EXTENSION_JOURNEY_EXECUTABLE -ErrorAction SilentlyContinue }
    if ($exit -ne 0) {
        $tail = @(Get-Content -LiteralPath $log | Select-String -Pattern '^Error:|Evidence:|Failed!' | Select-Object -First 6)
        throw "The installed-host journey failed (exit $exit). Log: $log`n$($tail -join "`n")"
    }
    $outcome = 'passed'
}
finally {
    # The class store goes even when the uninstall throws, which used to skip it.
    try { if ($installed) { Invoke-Setup 'Uninstall' } }
    finally {
        $runClasses = Split-Path -Parent $classesRoot
        Remove-Item -LiteralPath $runClasses -Recurse -Force -ErrorAction SilentlyContinue
        # And the lane's own parent key once no run is using it, so a pass leaves nothing in HKCU.
        $laneKey = Split-Path -Parent $runClasses
        if ((Test-Path -LiteralPath $laneKey) -and -not @(Get-ChildItem -LiteralPath $laneKey).Count) {
            Remove-Item -LiteralPath $laneKey -Force -ErrorAction SilentlyContinue
        }
    }
    # Pruned on a pass only, so a failure keeps what setup saw.
    if ($outcome -eq 'passed' -and -not $KeepInstall) {
        foreach ($path in @($staged, $installRoot)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }
    }
    [ordered]@{ outcome = $outcome; revision = $manifest.revision; version = $manifest.version; installRoot = $installRoot } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidenceRoot 'report.json') -Encoding utf8NoBOM
}
"Installed-host custom-view journey passed against revision $($manifest.revision). Evidence: $evidenceRoot"
