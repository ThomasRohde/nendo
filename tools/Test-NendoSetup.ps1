[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$evidence = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/evidence/runs'))) ('setup-tests-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($evidence)
$setup = Join-Path $PSScriptRoot 'Invoke-NendoSetup.ps1'
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }
function New-Payload([string] $Name, [hashtable] $Files) {
    $dir = Join-Path $evidence $Name
    [void][IO.Directory]::CreateDirectory($dir)
    $entries = foreach ($name in $Files.Keys) {
        $file = Join-Path $dir $name
        [void][IO.Directory]::CreateDirectory((Split-Path $file))
        [IO.File]::WriteAllText($file, $Files[$name])
        @{path=$name; sha256=(Get-FileHash -LiteralPath $file).Hash}
    }
    @{schemaVersion=1; product='Nendo'; buildId=$Name; files=@($entries)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $dir 'nendo-install.json')
    return $dir
}
# Setup registers .nendo, New > Nendo application, the application identity and the
# Start Menu shortcut. Every run here passes a class store and a Start Menu of its own:
# without them each fixture install took over what this account opens .nendo with and
# pointed the real shortcut at a folder that is deleted afterwards.
$classesRoot = "HKCU:\Software\Nendo-Setup-Tests\$([Guid]::NewGuid().ToString('N'))\Classes"
$startMenuRoot = Join-Path $evidence 'start-menu'
function Get-OwnerRegistrations {
    $classes = 'HKCU:\Software\Classes'
    $values = foreach ($key in @('.nendo', 'Nendo.Document\shell\open\command', 'Nendo.Document\DefaultIcon', 'Applications\Nendo.Desktop.exe\shell\open\command', '.nendo\ShellNew', 'AppUserModelId\Nendo.Desktop')) {
        $path = Join-Path $classes $key
        if (Test-Path -LiteralPath $path) { "$key=" + ((Get-ItemProperty -LiteralPath $path).PSObject.Properties | Where-Object Name -notlike 'PS*' | ForEach-Object { "$($_.Name):$($_.Value)" }) -join ';' } else { "$key=missing" }
    }
    $link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nendo.lnk'
    $values += if (Test-Path -LiteralPath $link) { "shortcut=$((Get-FileHash -LiteralPath $link).Hash)" } else { 'shortcut=missing' }
    return $values -join "`n"
}
$ownerBefore = Get-OwnerRegistrations
function Run-Setup([string] $Mode, [string] $Root, [string] $Payload, [bool] $Success=$true, [string[]] $Extra=@()) {
    $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$setup,'-Mode',$Mode,'-InstallRoot',$Root,'-ClassesRoot',$classesRoot,'-StartMenuRoot',$startMenuRoot)
    if ($Payload) { $arguments += @('-PayloadRoot',$Payload) }
    $arguments += $Extra
    $result = & $powershell @arguments 2>&1
    $exit = $LASTEXITCODE
    $result | Out-File -LiteralPath (Join-Path $evidence 'tests.log') -Append
    Assert (($exit -eq 0) -eq $Success) "Unexpected exit $exit for $Mode at $Root. See $evidence/tests.log"
}
try {
    $v1 = New-Payload 'v1' @{'app.txt'='version one'; 'stale/old.txt'='obsolete'}
    $v2 = New-Payload 'v2' @{'app.txt'='version two'; 'new.txt'='new file'}
    $root = Join-Path $evidence 'Nendo'
    Run-Setup Install $root $v1
    [IO.File]::WriteAllText((Join-Path $root 'user.nendo'),'user data stays exactly here')
    $userHash = (Get-FileHash -LiteralPath (Join-Path $root 'user.nendo')).Hash
    Run-Setup Install $root $v2
    Assert ((Get-Content -LiteralPath (Join-Path $root 'app.txt') -Raw) -eq 'version two') 'Upgrade did not replace payload.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root 'stale/old.txt'))) 'Stale owned file survived.'
    Assert ((Get-Content -LiteralPath (Join-Path "$root.previous" 'app.txt') -Raw) -eq 'version one') 'Previous payload not retained.'
    Assert ((Get-FileHash -LiteralPath (Join-Path $root 'user.nendo')).Hash -eq $userHash) 'Upgrade changed user file.'
    Run-Setup Install $root $v2
    Assert (@(Get-ChildItem -LiteralPath $evidence -Directory -Filter 'Nendo.previous*').Count -eq 1) 'Backup growth.'
    Assert ((Get-Content -LiteralPath (Join-Path "$root.previous" 'app.txt') -Raw) -eq 'version one') 'Reinstall discarded previous version.'
    # Explicit application rollback uses the same validated install path and preserves user files.
    Run-Setup Install $root $v1
    Assert ((Get-Content -LiteralPath (Join-Path $root 'app.txt') -Raw) -eq 'version one') 'Application rollback did not restore the previous payload.'
    Assert ((Get-FileHash -LiteralPath (Join-Path $root 'user.nendo')).Hash -eq $userHash) 'Application rollback changed user data.'
    Assert ((Get-Content -LiteralPath (Join-Path "$root.previous" 'app.txt') -Raw) -eq 'version two') 'Rollback discarded the newer recovery payload.'
    Run-Setup Install $root $v2
    # Execute the production capacity predicate with boundary measurements. This is
    # injected capacity evidence, not a claim that the physical disk was exhausted.
    $tokens = $null; $parseErrors = $null
    $setupAst = [Management.Automation.Language.Parser]::ParseFile($setup, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw 'Setup script does not parse.' }
    $capacityFunction = $setupAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-NendoSetupCapacity' }, $true)
    if ($null -eq $capacityFunction) { throw 'Production capacity predicate was not found.' }
    . ([scriptblock]::Create($capacityFunction.Extent.Text))
    $beforeCapacity = (Get-FileHash -LiteralPath (Join-Path $root 'app.txt')).Hash
    foreach ($available in @(0, (16MB + 299))) {
        $refused = $false
        try { Assert-NendoSetupCapacity $available 200 100 } catch { $refused = $_.Exception.Message -like 'Insufficient staging space:*' }
        Assert $refused 'Insufficient staging space was not refused.'
    }
    Assert-NendoSetupCapacity (16MB + 300) 200 100
    Assert ((Get-FileHash -LiteralPath (Join-Path $root 'app.txt')).Hash -eq $beforeCapacity) 'Capacity refusal changed installed bytes.'
    # Locked payload is refused without disturbing the installed version.
    $handle = [IO.File]::Open((Join-Path $root 'app.txt'),'Open','ReadWrite','None')
    try { Run-Setup Install $root $v1 $false } finally { $handle.Dispose() }
    Assert ((Get-Content -LiteralPath (Join-Path $root 'app.txt') -Raw) -eq 'version two') 'Locked upgrade changed payload.'
    # Pre-existing unowned path cannot be overwritten by a new release.
    $conflict = New-Payload 'conflict' @{'app.txt'='version three'; 'user.nendo'='overwrite forbidden'}
    Run-Setup Install $root $conflict $false
    Assert ((Get-FileHash -LiteralPath (Join-Path $root 'user.nendo')).Hash -eq $userHash) 'Collision changed user data.'
    # Corrupt extraction is refused before active bytes change.
    [IO.File]::WriteAllText((Join-Path $v1 'app.txt'),'corrupt')
    Run-Setup Install $root $v1 $false
    # Model interruption after one replacement: previous is complete, journal is durable.
    # Back up the active payload as an updater would do before touching any files.
    Copy-Item -LiteralPath (Join-Path $root 'app.txt') -Destination (Join-Path "$root.previous" 'app.txt') -Force
    Copy-Item -LiteralPath (Join-Path $root 'new.txt') -Destination (Join-Path "$root.previous" 'new.txt') -Force
    Copy-Item -LiteralPath (Join-Path $root 'nendo-install.json') -Destination (Join-Path "$root.previous" 'nendo-install.json') -Force
    Remove-Item -LiteralPath (Join-Path "$root.previous" 'stale/old.txt')
    $next = Get-Content -LiteralPath (Join-Path $conflict 'nendo-install.json') -Raw | ConvertFrom-Json
    $next.files = @($next.files | Where-Object path -ne 'user.nendo')
    @{schemaVersion=1; product='Nendo'; hadPrevious=$true; files=$next.files} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'nendo-update.json')
    [IO.File]::WriteAllText((Join-Path $root 'app.txt'),'version three')
    Run-Setup Recover $root ''
    Assert ((Get-Content -LiteralPath (Join-Path $root 'app.txt') -Raw) -eq 'version two') 'Interrupted update recovery failed.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root 'nendo-update.json'))) 'Recovery journal remained.'
    Run-Setup Uninstall $root ''
    Assert ((Get-FileHash -LiteralPath (Join-Path $root 'user.nendo')).Hash -eq $userHash) 'Uninstall changed user data.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root 'app.txt'))) 'Uninstall left payload.'
    Assert (-not (Test-Path -LiteralPath "$root.previous")) 'Uninstall left previous payload.'
    # The installer moves its extracted payload into place and keeps the backup as hard
    # links, so an upgrade writes no payload bytes a second time. Measured by file
    # identity rather than by time: the backup is the very file that was installed, and
    # the installed file is the very file that was extracted.
    function Get-FileId([string] $Path) {
        $id = [regex]::Match((& fsutil file queryfileid $Path | Out-String), '0x[0-9a-fA-F]+').Value
        Assert ([bool]$id) "No file ID for $Path"
        return $id
    }
    $moved = Join-Path $evidence 'moved\Nendo'
    $m1 = New-Payload 'm1' @{'app.txt'='moved one'; 'lib/core.dll'='core one'}
    $m2 = New-Payload 'm2' @{'app.txt'='moved two'; 'lib/core.dll'='core two'}
    Run-Setup Install $moved $m1 $true @('-MovePayload')
    Assert (-not (Test-Path -LiteralPath (Join-Path $m1 'app.txt'))) 'A moved payload was left where it was extracted.'
    $installedId = Get-FileId (Join-Path $moved 'lib/core.dll')
    $extractedId = Get-FileId (Join-Path $m2 'lib/core.dll')
    Run-Setup Install $moved $m2 $true @('-MovePayload')
    Assert ((Get-FileId (Join-Path "$moved.previous" 'lib/core.dll')) -eq $installedId) 'The backup was copied rather than linked.'
    Assert ((Get-FileId (Join-Path $moved 'lib/core.dll')) -eq $extractedId) 'The new payload was copied rather than moved.'
    Assert ((Get-Content -LiteralPath (Join-Path "$moved.previous" 'lib/core.dll') -Raw) -eq 'core one') 'A linked backup lost the previous bytes.'
    Assert ((Get-Content -LiteralPath (Join-Path $moved 'lib/core.dll') -Raw) -eq 'core two') 'A moved upgrade did not install the new payload.'
    # Interrupted halfway through a linked update: one file replaced, the other still a
    # hard link shared with its backup. Recovery copies the backup over that link, which
    # must not truncate the backup it is reading from.
    $m3 = New-Payload 'm3' @{'app.txt'='moved three'; 'lib/core.dll'='core three'}
    Remove-Item -LiteralPath "$moved.previous" -Recurse -Force
    foreach ($name in @('app.txt', 'lib/core.dll')) {
        $link = Join-Path "$moved.previous" $name
        [void][IO.Directory]::CreateDirectory((Split-Path $link))
        $null = New-Item -ItemType HardLink -Path $link -Value (Join-Path $moved $name)
    }
    Copy-Item -LiteralPath (Join-Path $moved 'nendo-install.json') -Destination (Join-Path "$moved.previous" 'nendo-install.json')
    $journal = Get-Content -LiteralPath (Join-Path $m3 'nendo-install.json') -Raw | ConvertFrom-Json
    @{schemaVersion=1; product='Nendo'; hadPrevious=$true; files=$journal.files} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $moved 'nendo-update.json')
    Remove-Item -LiteralPath (Join-Path $moved 'app.txt')
    [IO.File]::WriteAllText((Join-Path $moved 'app.txt'), 'moved three')
    Run-Setup Recover $moved ''
    Assert ((Get-Content -LiteralPath (Join-Path $moved 'app.txt') -Raw) -eq 'moved two') 'Recovery over a linked backup did not restore the replaced file.'
    Assert ((Get-Content -LiteralPath (Join-Path $moved 'lib/core.dll') -Raw) -eq 'core two') 'Recovery over a linked backup lost the file it shared.'
    Assert ((Get-Content -LiteralPath (Join-Path "$moved.previous" 'lib/core.dll') -Raw) -eq 'core two') 'Recovery truncated the backup it was restoring from.'
    # A traversal in even an unsigned local inventory must never escape the fixture.
    $bad = New-Payload 'bad' @{'ok.txt'='okay'}
    $inventory = Get-Content -LiteralPath (Join-Path $bad 'nendo-install.json') -Raw | ConvertFrom-Json
    $inventory.files[0].path = '..\outside.txt'
    $inventory | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $bad 'nendo-install.json')
    Run-Setup Install (Join-Path $evidence 'bad-install') $bad $false
    # The registrations landed in this run's own class store, and the account's did not move.
    Assert (Test-Path -LiteralPath (Join-Path $classesRoot '.nendo')) 'Setup wrote no association to the run class store.'
    $ownerAfter = Get-OwnerRegistrations
    Assert ($ownerAfter -eq $ownerBefore) "The setup tests changed this account's .nendo registration or Start Menu shortcut.`nBefore:`n$ownerBefore`nAfter:`n$ownerAfter"
}
finally {
    # The run's class store goes on every path, a failure included: one that stopped
    # between the first install and the end of the run used to leave it in HKCU for
    # good. Best effort, so a cleanup that fails cannot replace the error that got here.
    $runClasses = Split-Path -Parent $classesRoot
    Remove-Item -LiteralPath $runClasses -Recurse -Force -ErrorAction SilentlyContinue
    # And the lane's own parent key once no run is using it, so a pass leaves nothing in HKCU.
    $laneKey = Split-Path -Parent $runClasses
    if ((Test-Path -LiteralPath $laneKey) -and -not @(Get-ChildItem -LiteralPath $laneKey).Count) {
        Remove-Item -LiteralPath $laneKey -Force -ErrorAction SilentlyContinue
    }
}
Assert (-not (Test-Path -LiteralPath $runClasses)) "The run's class store survived its cleanup: $runClasses"
@{result='passed'; checks=@('fresh install','changed-version upgrade','same-version reinstall','application rollback/user-file retention','injected staging-capacity boundaries','one previous payload','stale owned removal','locked-file refusal','unowned collision refusal','corrupt extraction refusal','interrupted update recovery','uninstall/user-file retention','moved payload and linked backup by file identity','recovery over a linked backup','path traversal refusal','account registrations untouched'); shell='Windows PowerShell 5.1'; capacityLimitation='Injected measurements at the production predicate; no physical disk exhaustion.'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'results.json')
Write-Output "Nendo setup checks passed: $evidence"
