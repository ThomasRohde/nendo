[CmdletBinding()]
param([string] $PilotRoot = 'artifacts/build/publish')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pilot = (Resolve-Path -LiteralPath $PilotRoot).Path
$payload = Join-Path $pilot 'payload'
$manifest = Get-Content -LiteralPath (Join-Path $pilot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.kind -ne 'local-pilot' -or $manifest.runtimeIdentifier -ne 'win-x64') { throw 'Expected an x64 publish manifest.' }
$manifestHash = (Get-FileHash -LiteralPath (Join-Path $pilot 'manifest.json')).Hash.ToLowerInvariant()
$buildId = $manifestHash.Substring(0,16)
$output = Join-Path $repo 'artifacts/installer'
[void][IO.Directory]::CreateDirectory($output)
$candidate = Join-Path $output 'Nendo-Setup.next.exe'
$installer = Join-Path $output 'Nendo-Setup.exe'
$helper = Join-Path $PSScriptRoot 'Invoke-NendoSetup.ps1'
$setupFiles = @($manifest.files | ForEach-Object { @{path=$_.path; sha256=$_.sha256} }) + @(@{path='Nendo.Setup.ps1'; sha256=(Get-FileHash -LiteralPath $helper).Hash})
@{schemaVersion=1; product='Nendo'; version=$manifest.version; buildId=$buildId; files=$setupFiles} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $pilot 'nendo-install.json') -Encoding UTF8
$header = @'
Unicode true
RequestExecutionLevel user
!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
Name "Nendo"
SetCompressor /SOLID zlib
; The setup script does most of the work after the progress bar is full. Its steps
; stream into the details list, which is open so the window does not look stuck.
ShowInstDetails show
ShowUninstDetails show
InstallDir "$LOCALAPPDATA\Programs\Nendo"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Var SetupResult
Var KeepPilots
Function .onInit
  ${IfNot} ${RunningX64}
    Abort "Nendo requires Windows x64."
  ${EndIf}
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Nendo"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/KEEPLEGACYPILOTS" $KeepPilots
  IfErrors 0 +3
    StrCpy $KeepPilots "false"
    Goto +2
  StrCpy $KeepPilots "true"
FunctionEnd
Section "Install"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
'@
$lines = [Collections.Generic.List[string]]::new()
$lines.Add(('OutFile "{0}"' -f $candidate))
$lines.Add(('!define MUI_ICON "{0}"' -f (Join-Path $payload 'Assets/AppIcon.ico')))
$lines.Add(('!define MUI_UNICON "{0}"' -f (Join-Path $payload 'Assets/AppIcon.ico')))
$lines.Add($header)
foreach ($entry in $manifest.files) {
    $relative = [string]$entry.path
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)|["$\r\n]') { throw "Unsafe payload path: $relative" }
    $file = Join-Path $payload $relative
    if ((Get-FileHash -LiteralPath $file).Hash -ne $entry.sha256) { throw "Payload hash mismatch: $relative" }
    $lines.Add(('  SetOutPath "$PLUGINSDIR\payload\{0}"' -f (Split-Path $relative)))
    $lines.Add(('  File "{0}"' -f $file))
}
$lines.Add('  SetOutPath "$PLUGINSDIR\payload"')
$lines.Add(('  File /oname=Nendo.Setup.ps1 "{0}"' -f $helper))
$lines.Add(('  File "{0}"' -f (Join-Path $pilot 'nendo-install.json')))
$lines.Add(@'
  WriteUninstaller "$PLUGINSDIR\payload\Uninstall.exe"
  DetailPrint "Installing Nendo. This can take a minute."
  ; -MovePayload: the extracted files are moved into place rather than copied, which
  ; also moves the setup script. Anything after this runs the installed copy.
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload\Nendo.Setup.ps1" -Mode Install -InstallRoot "$INSTDIR" -PayloadRoot "$PLUGINSDIR\payload" -MovePayload -LogPath "$TEMP\Nendo-Setup.log"'
  Pop $SetupResult
  FileOpen $1 "$TEMP\Nendo-Setup.log" a
  FileWrite $1 "Install exit code: $SetupResult$\r$\n"
  FileClose $1
  StrCmp $SetupResult "0" installed
    IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "Nendo could not be installed. Close Nendo and check the setup details. Existing files have been retained for recovery."
    SetErrorLevel 1
    Quit
  installed:
  ; The Start Menu shortcut is written by the setup script, not here. It has to carry
  ; System.AppUserModel.ID for the taskbar to group and pin Nendo correctly, NSIS has
  ; no way to set a shell property, and the setup script is the half a test can run.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo" "DisplayName" "Nendo"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo" "DisplayIcon" '$\"$INSTDIR\Nendo.Desktop.exe$\",0'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
'@)
# The version a person reads in Apps & features, with the build identity beside
# it: the build ID answers which payload, the version answers which release.
$lines.Add(('  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo" "DisplayVersion" "{0}"' -f $manifest.version))
$lines.Add(('  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo" "BuildId" "{0}"' -f $buildId))
$lines.Add(@'
  StrCmp $KeepPilots "true" finished
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\Nendo.Setup.ps1" -Mode RetirePilots -InstallRoot "$INSTDIR" -LogPath "$TEMP\Nendo-Setup.log"'
  Pop $SetupResult
  FileOpen $1 "$TEMP\Nendo-Setup.log" a
  FileWrite $1 "RetirePilots exit code: $SetupResult$\r$\n"
  FileClose $1
  StrCmp $SetupResult "0" finished
    IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "Nendo is installed. An older pilot could not be removed; see setup details."
    SetErrorLevel 2
  finished:
SectionEnd
Function un.onInit
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\Nendo" valid
    Abort "Unexpected uninstall location; no files were removed."
  valid:
FunctionEnd
Section "Uninstall"
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\Nendo.Setup.ps1" "$PLUGINSDIR\Nendo.Setup.ps1"
  SetOutPath "$PLUGINSDIR"
  DetailPrint "Removing Nendo."
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Nendo.Setup.ps1" -Mode Uninstall -InstallRoot "$INSTDIR" -LogPath "$TEMP\Nendo-Setup.log"'
  Pop $SetupResult
  FileOpen $1 "$TEMP\Nendo-Setup.log" a
  FileWrite $1 "Uninstall exit code: $SetupResult$\r$\n"
  FileClose $1
  StrCmp $SetupResult "0" removed
    IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "Nendo could not be uninstalled. Close Nendo and check setup details."
    SetErrorLevel 1
    Quit
  removed:
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo"
SectionEnd
'@)
$script = Join-Path $pilot 'nendo.nsi'
$lines | Set-Content -LiteralPath $script
& makensis $script *> (Join-Path $pilot 'installer-build.log')
if ($LASTEXITCODE -ne 0) { throw "Installer build failed. See $pilot/installer-build.log" }
# Rotate the outgoing installer into the recovery slot only when we have a
# status record matching it, so an unknown binary never becomes the rollback
# copy. NOTE: installer-status.json is written by Test-NendoInstaller.ps1, which
# only runs on a clean Windows user — so on a machine with Nendo installed this
# rotation does not happen and Nendo-Setup.previous.exe stays where it is.
$statusPath = Join-Path $output 'installer-status.json'
if ((Test-Path -LiteralPath $installer) -and (Test-Path -LiteralPath $statusPath)) {
    $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $installer).Hash -eq $status.sha256) {
        Move-Item -LiteralPath $installer -Destination (Join-Path $output 'Nendo-Setup.previous.exe') -Force
        Copy-Item -LiteralPath $statusPath -Destination (Join-Path $output 'previous-installer-status.json') -Force
    }
}
Move-Item -LiteralPath $candidate -Destination $installer -Force
# Record what this build is and what has not been checked about it yet. Written
# here, by the step that produces the binary, so the record always describes the
# file sitting beside it. Each lane stamps its own entry when it runs.
[ordered]@{
    buildId = $buildId
    sha256 = (Get-FileHash -LiteralPath $installer).Hash
    builtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    signature = [string](Get-AuthenticodeSignature -LiteralPath $installer).Status
    scope = 'Local unsigned Windows x64, per-user install at Programs\Nendo'
    lanes = [ordered]@{
        setupLogic = [ordered]@{
            tool = 'tools/Test-NendoSetupIsolated.ps1'
            status = 'not run for this build'
            covers = 'Install, in-place upgrade, obsolete owned file removal, unowned user file preservation and uninstall, against a task-owned root.'
        }
        nsisWrapper = [ordered]@{
            tool = 'tools/Test-NendoInstaller.ps1'
            status = 'not run for this build'
            covers = 'NSIS bootstrapper, payload extraction, HKCU uninstall registration and the real Uninstall.exe.'
            note = 'Runs only under a clean Windows user, because it ends by uninstalling from the real per-user location. Not run is the normal state on a development machine and says nothing about the build.'
        }
    }
    notChecked = @('Authenticode signing', 'ARM64', 'Clean or offline machine', 'Human usability and accessibility')
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'installer-status.json')
@{ buildId=$buildId; manifestSha256=$manifestHash; installer=$installer; sha256=(Get-FileHash -LiteralPath $installer).Hash; nsisVersion=(& makensis /VERSION); signatureStatus=[string](Get-AuthenticodeSignature -LiteralPath $installer).Status; installRelativePath='Programs\Nendo'; uninstallPolicy='Owned payload only; unknown files and device settings retained.' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pilot 'installer.json')
Write-Output "Built Nendo installer: $installer"
