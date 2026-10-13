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
# The scripts are written as UTF-8 and makensis reads a script without a byte order mark
# in the ANSI code page unless told otherwise, which broke every File line of a checkout
# whose path is not ASCII.
$makensisArguments = @('/INPUTCHARSET', 'UTF8')
# The release the file carries in its properties and its window title. Windows wants
# four numbers for the file version; the product version is the payload's own.
$version = [string]$manifest.version
$versionNumbers = [regex]::Match($version, '^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?')
if (-not $versionNumbers.Success) { throw "The payload version '$version' does not start with major.minor.patch numbers." }
$fileVersion = '{0}.{1}.{2}.{3}' -f $versionNumbers.Groups[1].Value, $versionNumbers.Groups[2].Value, $versionNumbers.Groups[3].Value,
    $(if ($versionNumbers.Groups[4].Success) { $versionNumbers.Groups[4].Value } else { '0' })

# What the installer does around the setup script, as macros the probe below compiles
# and runs on its own as well, so the installer is built from logic that has been seen
# to work on this machine before it is built.
$macros = @'
; NSIS opens a file at offset 0 in every mode, append included. Without the seek
; each line overwrote the start of the setup log instead of following it.
!macro NendoAppendLog FILE TEXT
  FileOpen $1 "${FILE}" a
  FileSeek $1 0 END
  FileWrite $1 "${TEXT}$\r$\n"
  FileClose $1
!macroend
; The sentence setup wrote when it refused, so the message box says what the
; refusal was instead of one fixed text for all of them.
!macro NendoReadFailure FILE OUTVAR
  StrCpy ${OUTVAR} ""
  IfFileExists "${FILE}" 0 +4
    FileOpen $2 "${FILE}" r
    FileReadUTF16LE $2 ${OUTVAR}
    FileClose $2
!macroend
; A running program's executable cannot be opened for writing. Opening it for
; append and closing it again writes nothing.
!macro NendoFileInUse FILE OUTVAR
  StrCpy ${OUTVAR} "free"
  IfFileExists "${FILE}" 0 +7
    ClearErrors
    FileOpen $2 "${FILE}" a
    IfErrors +3
      FileClose $2
      Goto +2
    StrCpy ${OUTVAR} "in use"
!macroend
'@

# Those macros compiled from a folder whose name is not ASCII and run as a silent
# program: the log line lands at the end of an existing log, the failure sentence setup
# writes is the one read back, and the executable of a running process reads as in use
# while a free or absent file does not (and is not created). Nothing outside the probe's
# own folder is touched, and the folder goes when the probe passes.
function Test-NendoInstallerMacros {
    $probeRoot = Join-Path $repo ('artifacts/installer-probe-' + [Guid]::NewGuid().ToString('N'))
    $probe = Join-Path $probeRoot ('J' + [char]0x00F8 + 'rgen ' + [char]0x00D8)
    [void][IO.Directory]::CreateDirectory($probe)
    [IO.File]::WriteAllText((Join-Path $probe 'payload.txt'), 'probe payload')
    [IO.File]::WriteAllBytes((Join-Path $probe 'log.txt'), [Text.Encoding]::ASCII.GetBytes("first line`r`n"))
    $failure = 'Nendo is still running in the notification area ' + [char]0x00E6 + [char]0x00F8 + [char]0x00E5 + '.'
    [IO.File]::WriteAllText((Join-Path $probe 'failure.txt'), $failure, (New-Object Text.UnicodeEncoding($false, $false)))
    [IO.File]::WriteAllText((Join-Path $probe 'free.exe'), 'not running')
    $running = Join-Path $probe 'running.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $running
    $script = Join-Path $probe 'probe.nsi'
    @(
        'Unicode true'
        'RequestExecutionLevel user'
        'SilentInstall silent'
        'Name "Nendo installer probe"'
        ('OutFile "{0}"' -f (Join-Path $probe 'probe.exe'))
        $macros
        'Section'
        '  InitPluginsDir'
        '  SetOutPath "$PLUGINSDIR"'
        ('  File "{0}"' -f (Join-Path $probe 'payload.txt'))
        '  !insertmacro NendoAppendLog "$EXEDIR\log.txt" "Install exit code: 7"'
        '  !insertmacro NendoReadFailure "$EXEDIR\failure.txt" $3'
        '  !insertmacro NendoFileInUse "$EXEDIR\running.exe" $4'
        '  !insertmacro NendoFileInUse "$EXEDIR\free.exe" $5'
        '  !insertmacro NendoFileInUse "$EXEDIR\absent.exe" $6'
        '  FileOpen $0 "$EXEDIR\result.txt" w'
        '  FileWriteUTF16LE $0 "$3|$4|$5|$6"'
        '  FileClose $0'
        'SectionEnd'
    ) | Set-Content -LiteralPath $script -Encoding utf8
    $compileLog = Join-Path $probe 'compile.log'
    & makensis @makensisArguments $script *> $compileLog
    if ($LASTEXITCODE -ne 0) {
        throw "The installer probe did not compile from a folder with a non-ASCII name. See $compileLog`n$((Get-Content -LiteralPath $compileLog | Select-Object -Last 4) -join "`n")"
    }
    $holder = Start-Process -FilePath $running -ArgumentList '/d /c ping -n 60 127.0.0.1 >nul' -WindowStyle Hidden -PassThru
    try {
        $run = Start-Process -FilePath (Join-Path $probe 'probe.exe') -WindowStyle Hidden -PassThru -Wait
    } finally {
        if (-not $holder.HasExited) { & taskkill.exe /T /F /PID $holder.Id 2>&1 | Out-Null; [void]$holder.WaitForExit(10000) }
    }
    if ($run.ExitCode -ne 0) { throw "The installer probe exited with $($run.ExitCode). See $probe" }
    $log = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes((Join-Path $probe 'log.txt')))
    $expectedLog = "first line`r`nInstall exit code: 7`r`n"
    if ($log -ne $expectedLog) {
        throw "The installer's log line did not land at the end of the setup log. Expected '$($expectedLog.Replace("`r`n", '\r\n'))', found '$($log.Replace("`r`n", '\r\n'))'. See $probe"
    }
    $result = [IO.File]::ReadAllText((Join-Path $probe 'result.txt'), [Text.Encoding]::Unicode)
    $expectedResult = "$failure|in use|free|free"
    if ($result -ne $expectedResult) { throw "The installer probe read '$result', not '$expectedResult'. See $probe" }
    if (Test-Path -LiteralPath (Join-Path $probe 'absent.exe')) { throw "Checking whether a missing executable is in use created it. See $probe" }
    Remove-Item -LiteralPath $probeRoot -Recurse -Force
    Write-Output 'Installer probe passed: log append, failure sentence, running executable, non-ASCII path.'
}
Test-NendoInstallerMacros

$setupFiles = @($manifest.files | ForEach-Object { @{path=$_.path; sha256=$_.sha256} }) + @(@{path='Nendo.Setup.ps1'; sha256=(Get-FileHash -LiteralPath $helper).Hash})
@{schemaVersion=1; product='Nendo'; version=$manifest.version; buildId=$buildId; files=$setupFiles} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $pilot 'nendo-install.json') -Encoding UTF8
$header = @'
!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
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
Var SetupFailure
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
  ; Closing Nendo's window leaves it running in the notification area, so a person
  ; who closed it can still have it open. Ask now, before anything is extracted,
  ; rather than refuse after the whole payload has been unpacked. A silent run goes
  ; on, and setup's own refusal reaches its exit code and the log.
  IfSilent nendoClosed
  nendoRunning:
    !insertmacro NendoFileInUse "$INSTDIR\Nendo.Desktop.exe" $0
    StrCmp $0 "free" nendoClosed
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Nendo is still running. Closing its window leaves it in the notification area, by the clock.$\r$\n$\r$\nChoose Exit Nendo from its icon there, then choose Retry." IDRETRY nendoRunning
    Abort
  nendoClosed:
FunctionEnd
Section "Install"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
'@
$lines = [Collections.Generic.List[string]]::new()
$lines.Add('Unicode true')
$lines.Add('RequestExecutionLevel user')
# The version is in the window title ("Nendo 0.19.0 Setup") and in the file's
# properties, so two installers side by side can be told apart without running them.
$lines.Add(('Name "Nendo {0}"' -f $version))
$lines.Add(('VIProductVersion "{0}"' -f $fileVersion))
$lines.Add(('VIFileVersion "{0}"' -f $fileVersion))
$lines.Add('VIAddVersionKey /LANG=1033 "ProductName" "Nendo"')
$lines.Add(('VIAddVersionKey /LANG=1033 "ProductVersion" "{0}"' -f $version))
$lines.Add(('VIAddVersionKey /LANG=1033 "FileVersion" "{0}"' -f $fileVersion))
$lines.Add('VIAddVersionKey /LANG=1033 "FileDescription" "Nendo Setup"')
$lines.Add('VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 Thomas Klok Rohde and Nendo contributors (MIT License)"')
$lines.Add(('OutFile "{0}"' -f $candidate))
$lines.Add(('!define MUI_ICON "{0}"' -f (Join-Path $payload 'Assets/AppIcon.ico')))
$lines.Add(('!define MUI_UNICON "{0}"' -f (Join-Path $payload 'Assets/AppIcon.ico')))
$lines.Add($macros)
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
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload\Nendo.Setup.ps1" -Mode Install -InstallRoot "$INSTDIR" -PayloadRoot "$PLUGINSDIR\payload" -MovePayload -LogPath "$TEMP\Nendo-Setup.log" -FailurePath "$PLUGINSDIR\setup-failure.txt"'
  Pop $SetupResult
  !insertmacro NendoAppendLog "$TEMP\Nendo-Setup.log" "Install exit code: $SetupResult"
  StrCmp $SetupResult "0" installed
    !insertmacro NendoReadFailure "$PLUGINSDIR\setup-failure.txt" $SetupFailure
    StrCmp $SetupFailure "" 0 +2
      StrCpy $SetupFailure "The setup details say why."
    IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "Nendo could not be installed.$\r$\n$\r$\n$SetupFailure$\r$\n$\r$\nExisting files have been retained for recovery."
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
  !insertmacro NendoAppendLog "$TEMP\Nendo-Setup.log" "RetirePilots exit code: $SetupResult"
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
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Nendo.Setup.ps1" -Mode Uninstall -InstallRoot "$INSTDIR" -LogPath "$TEMP\Nendo-Setup.log" -FailurePath "$PLUGINSDIR\setup-failure.txt"'
  Pop $SetupResult
  !insertmacro NendoAppendLog "$TEMP\Nendo-Setup.log" "Uninstall exit code: $SetupResult"
  StrCmp $SetupResult "0" removed
    !insertmacro NendoReadFailure "$PLUGINSDIR\setup-failure.txt" $SetupFailure
    StrCmp $SetupFailure "" 0 +2
      StrCpy $SetupFailure "The setup details say why."
    IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "Nendo could not be uninstalled.$\r$\n$\r$\n$SetupFailure"
    SetErrorLevel 1
    Quit
  removed:
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nendo"
SectionEnd
'@)
$script = Join-Path $pilot 'nendo.nsi'
$lines | Set-Content -LiteralPath $script -Encoding utf8
& makensis @makensisArguments $script *> (Join-Path $pilot 'installer-build.log')
if ($LASTEXITCODE -ne 0) { throw "Installer build failed. See $pilot/installer-build.log" }
# Read the version back from the file Windows will show, before the build takes the name.
$carried = (Get-Item -LiteralPath $candidate).VersionInfo.ProductVersion
if ($carried -ne $version) { throw "The built installer carries product version '$carried', not the payload's $version." }
# Rotate the outgoing installer into the recovery slot only when the status record
# beside it describes it, so an unknown binary never becomes the rollback copy. This
# script writes that record itself below, for every build, so every rebuild moves the
# previous build into Nendo-Setup.previous.exe whether or not a lane checked it: the
# rollback copy is the previous build, and previous-installer-status.json says which
# of its lanes ran.
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
    version = $version
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
@{ buildId=$buildId; version=$version; manifestSha256=$manifestHash; installer=$installer; sha256=(Get-FileHash -LiteralPath $installer).Hash; nsisVersion=(& makensis /VERSION); signatureStatus=[string](Get-AuthenticodeSignature -LiteralPath $installer).Status; installRelativePath='Programs\Nendo'; uninstallPolicy='Owned payload only; unknown files and device settings retained.' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pilot 'installer.json')
Write-Output "Built Nendo installer: $installer"
