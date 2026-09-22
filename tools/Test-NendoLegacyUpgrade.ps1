[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$id = [Guid]::NewGuid().ToString('N').Substring(0,16)
$evidence = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/evidence/runs'))) "legacy-setup-test-$id"
[void][IO.Directory]::CreateDirectory($evidence)
$legacy = Join-Path $env:LOCALAPPDATA "Programs\NendoPilot\$id"
$registry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NendoPilot-$id"
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "Nendo Pilot $id.lnk"
if ((Test-Path -LiteralPath $legacy) -or (Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $shortcut)) { throw 'Fixture already exists.' }
$template = @'
Unicode true
RequestExecutionLevel user
Name "Nendo legacy migration fixture"
OutFile "@OUTPUT@\fixture.exe"
InstallDir "$LOCALAPPDATA\Programs\NendoPilot\@ID@"
Section
  SetOutPath "$INSTDIR"
  FileOpen $0 "$INSTDIR\owned.txt" w
  FileWrite $0 "legacy owned payload"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Nendo Pilot @ID@.lnk" "$INSTDIR\owned.txt"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NendoPilot-@ID@" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
SectionEnd
Function un.onInit
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\NendoPilot\@ID@" valid
    Abort "Unexpected location"
  valid:
FunctionEnd
Section "Uninstall"
  Delete "$INSTDIR\owned.txt"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\Nendo Pilot @ID@.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NendoPilot-@ID@"
  RMDir "$INSTDIR"
SectionEnd
'@
$template.Replace('@OUTPUT@',$evidence).Replace('@ID@',$id) | Set-Content -LiteralPath (Join-Path $evidence 'fixture.nsi')
& makensis (Join-Path $evidence 'fixture.nsi') *> (Join-Path $evidence 'compile.log')
if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed.' }
$process = Start-Process -FilePath (Join-Path $evidence 'fixture.exe') -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Fixture installation failed.' }
$canary = Join-Path $legacy 'user.nendo'
[IO.File]::WriteAllText($canary,'legacy user bytes')
$hash = (Get-FileHash -LiteralPath $canary).Hash
& (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Invoke-NendoSetup.ps1') -Mode RetirePilots -InstallRoot (Join-Path $env:LOCALAPPDATA 'Programs\Nendo') -LegacyId $id *> (Join-Path $evidence 'migration.log')
if ($LASTEXITCODE -ne 0) { throw "Legacy migration failed. See $evidence/migration.log" }
if ((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $shortcut) -or (Test-Path -LiteralPath (Join-Path $legacy 'owned.txt')) -or (Test-Path -LiteralPath (Join-Path $legacy 'Uninstall.exe'))) { throw 'Legacy owned entry remained.' }
if ((Get-FileHash -LiteralPath $canary).Hash -ne $hash) { throw 'Legacy user file changed.' }
@{result='passed'; legacyId=$id; shortcutRemoved=$true; registrationRemoved=$true; userFilePreserved=$true; ownedFilesRemoved=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'results.json')
Remove-Item -LiteralPath $canary
[IO.Directory]::Delete($legacy,$false)
Write-Output "Legacy pilot migration passed: $evidence"
