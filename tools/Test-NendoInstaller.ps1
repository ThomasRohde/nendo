[CmdletBinding()]
param([string] $PilotRoot = 'artifacts/build/publish', [switch] $DragAndDrop, [switch] $Performance)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pilot = (Resolve-Path -LiteralPath $PilotRoot).Path
$installer = Get-Content -LiteralPath (Join-Path $pilot 'installer.json') -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $pilot 'manifest.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $installer.installer).Hash -ne $installer.sha256 -or
    (Get-FileHash -LiteralPath (Join-Path $pilot 'manifest.json')).Hash -ne $installer.manifestSha256) { throw 'Installer or manifest changed.' }
if ($installer.buildId -notmatch '^[0-9a-f]{16}$') { throw 'Invalid build identity.' }
$installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs/Nendo'
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nendo.lnk'
# Safety interlock, not a quality gate. This lane installs and then UNINSTALLS
# from the real per-user location, registry key and Start Menu shortcut, so
# running it where Nendo is actually installed would destroy that installation.
if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath "$installRoot.previous") -or (Test-Path -LiteralPath $registration) -or (Test-Path -LiteralPath $shortcut)) {
    throw @"
Refusing to run: Nendo is installed at $installRoot.

This is a safety interlock, not a failure and not a finding about the build.
This lane ends by uninstalling from the real per-user location, so running it
here would remove your working installation.

To check setup logic now:      pwsh ./tools/Test-NendoSetupIsolated.ps1
To check the NSIS wrapper:     run this lane under a clean Windows user. It is
the only thing that covers the bootstrapper, payload extraction, HKCU uninstall
registration and the Start Menu shortcut.
"@
}
$previousInstaller = Join-Path (Split-Path $installer.installer) 'Nendo-Setup.previous.exe'
$previousVerified = Join-Path (Split-Path $installer.installer) 'previous-installer-status.json'
$upgradedPrevious = $false
$upgradeCanary = Join-Path $installRoot 'upgrade-user-retention.nendo'
if ((Test-Path -LiteralPath $previousInstaller) -and (Test-Path -LiteralPath $previousVerified)) {
    $previousCheck = Get-Content -LiteralPath $previousVerified -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $previousInstaller).Hash -ne $previousCheck.sha256) { throw 'Previous installer verification differs.' }
    $oldProcess = Start-Process -FilePath $previousInstaller -ArgumentList '/S /KEEPLEGACYPILOTS' -WindowStyle Hidden -PassThru -Wait
    if ($oldProcess.ExitCode -ne 0) { throw 'Previous installer failed.' }
    [IO.File]::WriteAllText($upgradeCanary,'Unknown user bytes must survive an upgrade.')
    $upgradeCanaryHash = (Get-FileHash -LiteralPath $upgradeCanary).Hash
    # Add an inventoried obsolete file to the task-owned preceding installation.
    $obsolete = Join-Path $installRoot 'obsolete-upgrade-fixture.txt'
    [IO.File]::WriteAllText($obsolete,'Old owned payload removed by the next version.')
    $oldInventoryPath = Join-Path $installRoot 'nendo-install.json'
    $oldInventory = Get-Content -LiteralPath $oldInventoryPath -Raw | ConvertFrom-Json
    $oldInventory.files = @($oldInventory.files) + @(@{path='obsolete-upgrade-fixture.txt'; sha256=(Get-FileHash -LiteralPath $obsolete).Hash})
    $oldInventory | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $oldInventoryPath
    $upgradedPrevious = $true
}
$installProcess = Start-Process -FilePath $installer.installer -ArgumentList '/S /KEEPLEGACYPILOTS' -WindowStyle Hidden -PassThru -Wait
if ($installProcess.ExitCode -ne 0) { throw "Install failed: $($installProcess.ExitCode)" }
if ($upgradedPrevious -and ((Test-Path -LiteralPath $obsolete) -or (Get-FileHash -LiteralPath $upgradeCanary).Hash -ne $upgradeCanaryHash)) { throw 'Previous-version upgrade did not preserve ownership boundaries.' }
foreach ($entry in $manifest.files) {
    if ([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Unsafe manifest path.' }
    if ((Get-FileHash -LiteralPath (Join-Path $installRoot $entry.path)).Hash -ne $entry.sha256) { throw "Installed bytes differ: $($entry.path)" }
}
$canary = Join-Path $installRoot 'user-retention-check.txt'
[IO.File]::WriteAllText($canary, 'Unknown user file must survive uninstall.')
$canaryHash = (Get-FileHash -LiteralPath $canary).Hash
$repeatProcess = Start-Process -FilePath $installer.installer -ArgumentList '/S /KEEPLEGACYPILOTS' -WindowStyle Hidden -PassThru -Wait
if ($repeatProcess.ExitCode -ne 0 -or (Get-FileHash -LiteralPath $canary).Hash -ne $canaryHash) { throw 'In-place reinstall failed or changed the user file.' }
if ((Get-ItemProperty -LiteralPath $registration).DisplayName -ne 'Nendo' -or -not (Test-Path -LiteralPath $shortcut)) { throw 'Stable registration or shortcut missing.' }
foreach ($entry in $manifest.files) { if ((Get-FileHash -LiteralPath (Join-Path $installRoot $entry.path)).Hash -ne $entry.sha256) { throw "Upgrade bytes differ: $($entry.path)" } }
$runtimeScript = if ($DragAndDrop) { 'Test-JourneyDrag.ps1' } else { 'Test-JourneyPilot.ps1' }
& (Join-Path $PSScriptRoot $runtimeScript) -Executable (Join-Path $installRoot 'Nendo.Desktop.exe') *> (Join-Path $pilot 'installed-runtime.log')
if (-not $?) { throw 'Installed runtime failed; retained installation for diagnosis.' }
$runtimeLog = Get-Content -LiteralPath (Join-Path $pilot 'installed-runtime.log')
$runtimeLine = @($runtimeLog | Where-Object { $_ -like 'Pilot runtime evidence: *' })
if ($runtimeLine.Count -ne 1) { throw 'Missing runtime evidence directory.' }
$runtimeRoot = $runtimeLine[0].Substring('Pilot runtime evidence: '.Length)
$userFile = Join-Path $runtimeRoot 'pilot.nendo'
$userFileHash = (Get-FileHash -LiteralPath $userFile).Hash
if ($Performance) {
    & pwsh (Join-Path $PSScriptRoot 'Review-DesktopPerformance.ps1') -Executable (Join-Path $installRoot 'Nendo.Desktop.exe') *> (Join-Path $pilot 'installed-performance.log')
    if ($LASTEXITCODE -ne 0) { throw 'Installed performance failed; retained task-owned installation and evidence for diagnosis.' }
}
$uninstall = Join-Path $installRoot 'Uninstall.exe'
$uninstallProcess = Start-Process -FilePath $uninstall -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller launcher failed: $($uninstallProcess.ExitCode)" }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ((Test-Path -LiteralPath $uninstall) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
foreach ($entry in $manifest.files) { if (Test-Path -LiteralPath (Join-Path $installRoot $entry.path)) { throw "Uninstall left owned payload: $($entry.path)" } }
if ((Get-FileHash -LiteralPath $canary).Hash -ne $canaryHash) { throw 'Uninstall changed an unknown user file.' }
if ((Get-FileHash -LiteralPath $userFile).Hash -ne $userFileHash) { throw 'Uninstall changed the user database.' }
if (Test-Path -LiteralPath $uninstall) { throw 'Uninstaller did not finish.' }
if ((Test-Path $registration) -or (Test-Path -LiteralPath $shortcut)) { throw 'Uninstall left its registration or shortcut.' }
if (Test-Path -LiteralPath "$installRoot.previous") { throw 'Uninstall left its rollback payload.' }
if ($upgradedPrevious) {
    if ((Get-FileHash -LiteralPath $upgradeCanary).Hash -ne $upgradeCanaryHash) { throw 'Uninstall changed upgrade canary.' }
    Remove-Item -LiteralPath $upgradeCanary
}
@{ result = 'passed'; buildId = $installer.buildId; upgradedPreviousInstaller=$upgradedPrevious; installedFiles = $manifest.files.Count; unknownFilePreserved = $true; userFileSha256 = $userFileHash; userFilePreserved = $true; runtimeEvidence = $runtimeRoot; inPlaceReinstall = $true; registrationRemoved = $true; limitations = @('Current user, not clean-user qualification', 'Existing WebView2 runtime', 'No disconnected-machine or human claim'); os = [Environment]::OSVersion.VersionString } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pilot 'installer-smoke.json')
# Remove only the probe-created canary and its now-empty directory, never recursively.
Remove-Item -LiteralPath $canary
[IO.Directory]::Delete($installRoot, $false)

# Stamp this lane's result onto the installer status record, when one exists for
# the same build. Never rewrites the whole record: each lane owns one entry.
function Update-InstallerLane {
    param([Parameter(Mandatory)][string] $StatusPath, [Parameter(Mandatory)][string] $Lane,
          [Parameter(Mandatory)][string] $BuildId, [Parameter(Mandatory)][string] $Status, [string] $Evidence)
    if (-not (Test-Path -LiteralPath $StatusPath)) { return }
    $record = Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
    if ($record.buildId -ne $BuildId) { return }
    $record.lanes.$Lane.status = $Status
    if ($Evidence) { $record.lanes.$Lane | Add-Member -NotePropertyName evidence -NotePropertyValue $Evidence -Force }
    $record.lanes.$Lane | Add-Member -NotePropertyName checkedUtc -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('O')) -Force
    $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StatusPath
}
Update-InstallerLane -StatusPath (Join-Path (Split-Path $installer.installer) 'installer-status.json') `
    -Lane 'nsisWrapper' -BuildId $installer.buildId -Status 'passed' -Evidence (Join-Path $pilot 'installer-smoke.json')
Write-Output "Installed pilot smoke passed: $pilot"
