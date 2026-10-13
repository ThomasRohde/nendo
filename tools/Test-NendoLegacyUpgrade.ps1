[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$id = [Guid]::NewGuid().ToString('N').Substring(0,16)
$evidence = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/evidence/runs'))) "legacy-setup-test-$id"
[void][IO.Directory]::CreateDirectory($evidence)
# The fixture has to sit where a real pilot did, because that is the only place
# RetirePilots looks: a folder under Programs\NendoPilot, an Uninstall key and a Start
# Menu shortcut, each named for this run's id. All three go in the finally below, on a
# failure as on a pass, and the lane checks that they went.
$legacy = Join-Path $env:LOCALAPPDATA "Programs\NendoPilot\$id"
$registry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NendoPilot-$id"
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "Nendo Pilot $id.lnk"
# Setup uses the install root in this mode only to check it and to serialize runs, so
# the lane gives it one of its own. The person's install root refused whenever their
# Nendo was running, and has no business in a test of the retirement.
$installRoot = Join-Path $evidence 'install'
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
# Written as UTF-8, so makensis is told so; it reads a script without a byte order mark
# in the ANSI code page, which breaks on a checkout path that is not ASCII.
$template.Replace('@OUTPUT@',$evidence).Replace('@ID@',$id) | Set-Content -LiteralPath (Join-Path $evidence 'fixture.nsi') -Encoding utf8
& makensis /INPUTCHARSET UTF8 (Join-Path $evidence 'fixture.nsi') *> (Join-Path $evidence 'compile.log')
if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed.' }
try {
    $process = Start-Process -FilePath (Join-Path $evidence 'fixture.exe') -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw 'Fixture installation failed.' }
    $canary = Join-Path $legacy 'user.nendo'
    [IO.File]::WriteAllText($canary,'legacy user bytes')
    $hash = (Get-FileHash -LiteralPath $canary).Hash
    & (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Invoke-NendoSetup.ps1') -Mode RetirePilots -InstallRoot $installRoot -BrowserProfileRoot (Join-Path $evidence 'device-state\WebView2') -LegacyId $id *> (Join-Path $evidence 'migration.log')
    if ($LASTEXITCODE -ne 0) { throw "Legacy migration failed. See $evidence/migration.log" }
    if ((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $shortcut) -or (Test-Path -LiteralPath (Join-Path $legacy 'owned.txt')) -or (Test-Path -LiteralPath (Join-Path $legacy 'Uninstall.exe'))) { throw 'Legacy owned entry remained.' }
    if ((Get-FileHash -LiteralPath $canary).Hash -ne $hash) { throw 'Legacy user file changed.' }
    @{result='passed'; legacyId=$id; shortcutRemoved=$true; registrationRemoved=$true; userFilePreserved=$true; ownedFilesRemoved=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'results.json')
} finally {
    # Every trace of this run's fixture, whatever stopped it. Each step is best effort,
    # so a cleanup that fails cannot replace the error that got here; what remains is
    # then named below.
    if (Test-Path -LiteralPath $registry) { Remove-Item -LiteralPath $registry -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $legacy) {
        foreach ($name in @('user.nendo', 'owned.txt', 'Uninstall.exe')) {
            $file = Join-Path $legacy $name
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
        }
        try { [IO.Directory]::Delete($legacy, $false) } catch { }
    }
    $left = @($registry, $shortcut, $legacy | Where-Object { Test-Path -LiteralPath $_ })
    if ($left.Count -gt 0) { Write-Warning "The legacy fixture left: $($left -join '; ')" }
}
if ($left.Count -gt 0) { throw "The legacy fixture was not cleaned up: $($left -join '; ')" }
Write-Output "Legacy pilot migration passed: $evidence"
