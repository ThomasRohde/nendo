# The custom-view journey, run against Nendo as setup installs it rather than as the
# build leaves it. The source journey launches artifacts/bin; this lane installs the
# published payload through the same Invoke-NendoSetup.ps1 the installer bundles, into a
# root of this run's own, and points DesktopExtensionViewJourneyTests at the installed
# executable. What that adds over the source run: the installed layout, and the installed
# Workbench with the view API every view origin serves (Workbench/_nendo/api.js).
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

# Start-Process joins -ArgumentList with spaces and quotes nothing, so a path with a
# space reached setup as two arguments. Each one is quoted the way a Windows command
# line is split: backslashes before a quote are doubled and the quote is escaped.
function ConvertTo-CommandLine([string[]] $Arguments) {
    return (@($Arguments | ForEach-Object {
        if ($_ -and $_ -notmatch '[\s"]') { $_ }
        else { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
    }) -join ' ')
}
function Invoke-Setup([string] $Mode, [string[]] $Extra = @()) {
    $log = Join-Path $evidenceRoot "setup-$($Mode.ToLowerInvariant()).log"
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $setup,
        '-Mode', $Mode, '-InstallRoot', $installRoot, '-ClassesRoot', $classesRoot, '-StartMenuRoot', $startMenuRoot,
        # A browser profile folder of the run's own, never this account's real one.
        '-BrowserProfileRoot', (Join-Path $evidenceRoot 'device-state\WebView2')) + $Extra
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList (ConvertTo-CommandLine $arguments) -WindowStyle Hidden -PassThru -Wait `
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
        # VSTest exits 0 when the filter matches nothing, so a renamed class passed this
        # lane having run no test. Matching nothing is an error, and the lane counts what
        # passed against the test methods the class declares.
        dotnet test (Join-Path $repoRoot 'tests/Nendo.Desktop.Tests/Nendo.Desktop.Tests.csproj') --no-restore `
            --filter 'FullyQualifiedName~DesktopExtensionViewJourneyTests' -- RunConfiguration.TreatNoTestsAsError=true *> $log
        $exit = $LASTEXITCODE
    }
    finally { Remove-Item Env:NENDO_EXTENSION_JOURNEY_EXECUTABLE -ErrorAction SilentlyContinue }
    if ($exit -ne 0) {
        $tail = @(Get-Content -LiteralPath $log | Select-String -Pattern '^Error:|Evidence:|Failed!' | Select-Object -First 6)
        throw "The installed-host journey failed (exit $exit). Log: $log`n$($tail -join "`n")"
    }
    $journeySource = Get-Content -LiteralPath (Join-Path $repoRoot 'tests/Nendo.Desktop.Tests/DesktopExtensionViewJourneyTests.cs') -Raw
    $expectedTests = [regex]::Matches($journeySource, '\[TestMethod\b').Count
    $passedLine = [regex]::Match((Get-Content -LiteralPath $log -Raw), 'Passed:\s*(\d+)')
    $passedTests = if ($passedLine.Success) { [int]$passedLine.Groups[1].Value } else { 0 }
    if ($expectedTests -eq 0 -or $passedTests -ne $expectedTests) {
        throw "The installed-host journey ran $passedTests passing test(s); DesktopExtensionViewJourneyTests declares $expectedTests. Log: $log"
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
