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
# And a browser profile folder of its own, the one setup moves an older version's profile
# into, so the move never reaches this account's real profile.
$script:browserProfileRoot = Join-Path $evidence 'device-state\WebView2'
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
    $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$setup,'-Mode',$Mode,'-InstallRoot',$Root,'-ClassesRoot',$classesRoot,'-StartMenuRoot',$startMenuRoot,'-BrowserProfileRoot',$script:browserProfileRoot)
    if ($Payload) { $arguments += @('-PayloadRoot',$Payload) }
    $arguments += $Extra
    $result = & $powershell @arguments 2>&1
    $exit = $LASTEXITCODE
    $result | Out-File -LiteralPath (Join-Path $evidence 'tests.log') -Append
    $script:lastSetupOutput = ($result | Out-String)
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
    Assert (-not (Test-Path -LiteralPath (Join-Path $root 'stale'))) 'An upgrade left behind the empty folder of an owned file it removed.'
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
    # The production predicate for which running Nendo keeps setup out. Another sign-in
    # session's process has a path this account cannot read, and its install is not this one.
    $blocksFunction = $setupAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-NendoProcessBlocks' }, $true)
    if ($null -eq $blocksFunction) { throw 'Production running-process predicate was not found.' }
    . ([scriptblock]::Create($blocksFunction.Extent.Text))
    Assert (-not (Test-NendoProcessBlocks $null 7 1 @('C:\x\Nendo'))) "Another session's Nendo, whose path cannot be read, kept this account's setup out."
    Assert (Test-NendoProcessBlocks $null 1 1 @('C:\x\Nendo')) 'A Nendo in this session whose path cannot be read did not keep setup out.'
    Assert (Test-NendoProcessBlocks 'C:\x\Nendo.previous\Nendo.Desktop.exe' 1 1 @('C:\x\Nendo', 'C:\x\Nendo.previous')) 'A Nendo running from the backup did not keep setup out.'
    Assert (-not (Test-NendoProcessBlocks 'C:\x\Nendo2\Nendo.Desktop.exe' 1 1 @('C:\x\Nendo'))) 'A Nendo in a sibling folder kept setup out.'
    # The identical-payload comparison is one lookup per entry. Over 2,000 entries the
    # quadratic comparison it replaces took tens of seconds; the bound leaves a wide margin.
    $sameFunction = $setupAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-SamePayload' }, $true)
    if ($null -eq $sameFunction) { throw 'Production identical-payload comparison was not found.' }
    . ([scriptblock]::Create($sameFunction.Extent.Text))
    $manyEntries = @(for ($i = 0; $i -lt 2000; $i++) { [pscustomobject]@{ path = "lib/file$i.dll"; sha256 = ('{0:X64}' -f $i) } })
    $comparisonClock = [Diagnostics.Stopwatch]::StartNew()
    $sameResult = Test-SamePayload ([pscustomobject]@{ files = $manyEntries }) ([pscustomobject]@{ files = $manyEntries })
    $comparisonSeconds = $comparisonClock.Elapsed.TotalSeconds
    Assert $sameResult 'Two identical inventories were not recognised as the same payload.'
    Assert ($comparisonSeconds -lt 2) "Comparing two 2,000-entry inventories took $([math]::Round($comparisonSeconds, 2)) s; it should be a lookup per entry."
    # Locked payload is refused without disturbing the installed version.
    $handle = [IO.File]::Open((Join-Path $root 'app.txt'),'Open','ReadWrite','None')
    try { Run-Setup Install $root $v1 $false } finally { $handle.Dispose() }
    Assert ((Get-Content -LiteralPath (Join-Path $root 'app.txt') -Raw) -eq 'version two') 'Locked upgrade changed payload.'
    # A virus scanner opens the files just linked into the backup being built, and a folder
    # cannot be renamed while a file in it is open: the isolated lane once failed renaming
    # .previous.partial to .previous. Setup waits that out. A job opens one file of that backup
    # as soon as it appears, keeps it open until the backup's inventory is written, which the
    # rename follows at once, and a while longer. The file held is the installed inventory's
    # first, which setup links first, and two hundred more after it keep the backup building
    # long enough for the job to be holding it before the rename is tried, whatever order a
    # hashtable gave the payload's files.
    function Start-BackupHold([string] $Root, [int] $HoldMilliseconds) {
        $ready = Join-Path $evidence ('hold-ready-' + [Guid]::NewGuid().ToString('N'))
        $firstLinked = @((Get-Content -LiteralPath (Join-Path $Root 'nendo-install.json') -Raw | ConvertFrom-Json).files)[0].path
        $job = Start-Job -ArgumentList "$Root.previous.partial", $HoldMilliseconds, $ready, $firstLinked -ScriptBlock {
            param($partial, $holdMilliseconds, $ready, $firstLinked)
            [IO.File]::WriteAllText($ready, 'ready')
            $first = Join-Path $partial $firstLinked
            $clock = [Diagnostics.Stopwatch]::StartNew()
            $handle = $null
            while ($null -eq $handle -and $clock.Elapsed.TotalSeconds -lt 120) {
                if (Test-Path -LiteralPath $first) { try { $handle = [IO.File]::Open($first, 'Open', 'Read', 'ReadWrite') } catch { $handle = $null } }
                if ($null -eq $handle) { Start-Sleep -Milliseconds 2 }
            }
            if ($null -eq $handle) { return 'never-held' }
            try {
                $inventory = Join-Path $partial 'nendo-install.json'
                while (-not (Test-Path -LiteralPath $inventory) -and $clock.Elapsed.TotalSeconds -lt 120) { Start-Sleep -Milliseconds 2 }
                Start-Sleep -Milliseconds $holdMilliseconds
                # The rename follows the inventory at once, so a folder still here was refused while held.
                if (Test-Path -LiteralPath $partial) { 'held-across-rename' } else { 'renamed-while-held' }
            } finally { $handle.Dispose() }
        }
        while (-not (Test-Path -LiteralPath $ready) -and $job.State -eq 'Running') { Start-Sleep -Milliseconds 50 }
        return $job
    }
    $heldRoot = Join-Path $evidence 'held\Nendo'
    $parts = @{}
    for ($i = 0; $i -lt 200; $i++) { $parts["lib/part$i.txt"] = "part $i" }
    $h1 = New-Payload 'h1' ($parts + @{'app.txt'='held one'})
    $h2 = New-Payload 'h2' ($parts + @{'app.txt'='held two'})
    $h3 = New-Payload 'h3' ($parts + @{'app.txt'='held three'})
    Run-Setup Install $heldRoot $h1
    $holdJob = Start-BackupHold $heldRoot 1000
    try { Run-Setup Install $heldRoot $h2 } finally { $holdResult = Receive-Job $holdJob -Wait -AutoRemoveJob }
    Assert ($holdResult -eq 'held-across-rename') "The backup folder was not held while setup renamed it ($holdResult), so this check proved nothing."
    Assert ((Get-Content -LiteralPath (Join-Path $heldRoot 'app.txt') -Raw) -eq 'held two') 'An upgrade whose backup folder was held for a second did not install.'
    Assert ((Get-Content -LiteralPath (Join-Path "$heldRoot.previous" 'app.txt') -Raw) -eq 'held one') 'An upgrade whose backup folder was held for a second kept no backup.'
    # Held past the retries (40 x 250 ms), the upgrade refuses before a new file is put in
    # place: the installed version stands, its backup waits under .partial, no update journal
    # is left, and the next run goes ahead.
    $holdJob = Start-BackupHold $heldRoot 15000
    try { Run-Setup Install $heldRoot $h3 $false } finally { $holdResult = Receive-Job $holdJob -Wait -AutoRemoveJob }
    Assert ($holdResult -eq 'held-across-rename') "The backup folder was not held past the retries ($holdResult), so this check proved nothing."
    Assert (($script:lastSetupOutput -replace '\r?\n', '') -match [regex]::Escape("The backup folder $heldRoot.previous.partial stayed in use for 10 seconds, so the installed version was left as it was.")) "The refusal over a held backup folder does not say so in a sentence:`n$($script:lastSetupOutput)"
    Assert ((Get-Content -LiteralPath (Join-Path $heldRoot 'app.txt') -Raw) -eq 'held two') 'A refused upgrade over a held backup folder changed the installed version.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $heldRoot 'nendo-update.json'))) 'A refused upgrade over a held backup folder left an update journal.'
    Assert ((Get-Content -LiteralPath (Join-Path "$heldRoot.previous.partial" 'app.txt') -Raw) -eq 'held two') 'A refused upgrade over a held backup folder lost the backup it had built.'
    Run-Setup Install $heldRoot $h3
    Assert ((Get-Content -LiteralPath (Join-Path $heldRoot 'app.txt') -Raw) -eq 'held three') 'The run after a refused upgrade did not install.'
    Assert ((Get-Content -LiteralPath (Join-Path "$heldRoot.previous" 'app.txt') -Raw) -eq 'held two') 'The run after a refused upgrade kept no backup of what was installed.'
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
    # Registration fails after the payload has landed, and the same installer is run
    # again once the cause is gone. The rerun is the identical-payload path, and it has
    # to register again rather than report success over a missing shortcut.
    # The failure is real rather than injected: a file where the Start Menu folder
    # should be makes the shortcut writer's CreateDirectory throw, after the
    # association has already been written. The association is then taken away as
    # well, so the rerun has to put back both halves.
    $retry = Join-Path $evidence 'retry\Nendo'
    $r1 = New-Payload 'r1' @{'app.txt'='retry one'}
    $r2 = New-Payload 'r2' @{'app.txt'='retry two'}
    Run-Setup Install $retry $r1
    $shortcut = Join-Path $startMenuRoot 'Nendo.lnk'
    Remove-Item -LiteralPath $startMenuRoot -Recurse -Force
    [IO.File]::WriteAllText($startMenuRoot, 'a file where the Start Menu folder should be')
    Run-Setup Install $retry $r2 $false
    Assert ((Get-Content -LiteralPath (Join-Path $retry 'app.txt') -Raw) -eq 'retry two') 'The failed registration run did not leave its payload installed.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $retry 'nendo-update.json'))) 'The failed registration run left an update journal.'
    foreach ($key in @('Nendo.Document', '.nendo')) { Remove-Item -LiteralPath (Join-Path $classesRoot $key) -Recurse -Force }
    Remove-Item -LiteralPath $startMenuRoot -Force
    Run-Setup Install $retry $r2
    $retryCommand = '"' + (Join-Path $retry 'Nendo.Desktop.exe') + '" "%1"'
    $openCommand = Join-Path $classesRoot 'Nendo.Document\shell\open\command'
    $registered = if (Test-Path -LiteralPath $openCommand) { [string](Get-ItemProperty -LiteralPath $openCommand).'(default)' } else { 'missing' }
    Assert ($registered -eq $retryCommand) "The rerun did not recreate the file association: expected '$retryCommand', found '$registered'."
    $extensionKey = Join-Path $classesRoot '.nendo'
    $extensionProgId = if (Test-Path -LiteralPath $extensionKey) { [string](Get-ItemProperty -LiteralPath $extensionKey).'(default)' } else { 'missing' }
    Assert ($extensionProgId -eq 'Nendo.Document') "The rerun did not point .nendo back at Nendo.Document; found '$extensionProgId'."
    Assert (Test-Path -LiteralPath $shortcut -PathType Leaf) "The rerun did not recreate the Start Menu shortcut at $shortcut."
    # Read back by the shell's own reader, independent of the writer in setup.
    $linkTarget = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
    Assert ($linkTarget -eq (Join-Path $retry 'Nendo.Desktop.exe')) "The recreated Start Menu shortcut points at '$linkTarget', not at this install."
    Assert ((Get-Content -LiteralPath (Join-Path "$retry.previous" 'app.txt') -Raw) -eq 'retry one') 'The rerun discarded the backup of the version before it.'
    # A file gone from the installed payload -- quarantined, deleted -- is put back by
    # rerunning the same installer, and it stops neither an upgrade nor an uninstall.
    $repair = Join-Path $evidence 'repair\Nendo'
    $p1 = New-Payload 'p1' @{'app.txt'='repair one'; 'lib/core.dll'='repair core one'}
    $p2 = New-Payload 'p2' @{'app.txt'='repair two'; 'lib/core.dll'='repair core two'}
    Run-Setup Install $repair $p1
    # The browser profile an earlier version kept beside the executable holds a view's
    # unsaved drafts. A refused upgrade leaves it where it is; the first install that goes
    # ahead moves it, contents and all, to where the application now looks; an unknown
    # file beside it stays.
    function New-OldProfile([string] $Folder, [string] $Text) {
        $storage = Join-Path $Folder 'Nendo.Desktop.exe.WebView2\EBWebView\Default\Local Storage'
        [void][IO.Directory]::CreateDirectory($storage)
        [IO.File]::WriteAllText((Join-Path $storage 'leveldb.log'), $Text)
    }
    $movedDraft = Join-Path $script:browserProfileRoot 'EBWebView\Default\Local Storage\leveldb.log'
    New-OldProfile $repair 'an unsaved Garden draft'
    [IO.File]::WriteAllText((Join-Path $repair 'notes.nendo'), 'user bytes')
    $refusedPayload = New-Payload 'p-refused' @{'app.txt'='refused'; 'notes.nendo'='overwrite forbidden'}
    Run-Setup Install $repair $refusedPayload $false
    Assert (Test-Path -LiteralPath (Join-Path $repair 'Nendo.Desktop.exe.WebView2')) 'A refused upgrade moved or removed the old browser profile.'
    Remove-Item -LiteralPath (Join-Path $repair 'lib/core.dll')
    Run-Setup Install $repair $p1
    Assert ((Test-Path -LiteralPath (Join-Path $repair 'lib/core.dll')) -and (Get-Content -LiteralPath (Join-Path $repair 'lib/core.dll') -Raw) -eq 'repair core one') 'Rerunning the same payload did not restore a missing owned file.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $repair 'Nendo.Desktop.exe.WebView2'))) 'Setup left the browser profile an earlier version kept in the install folder.'
    Assert ((Test-Path -LiteralPath $movedDraft) -and (Get-Content -LiteralPath $movedDraft -Raw) -eq 'an unsaved Garden draft') "The old browser profile was not moved to $($script:browserProfileRoot) with its contents, so a view's unsaved draft was lost."
    Assert (Test-Path -LiteralPath (Join-Path $repair 'notes.nendo')) 'Moving the old browser profile took an unknown file with it.'
    # Once a profile is in the new place, an old one found later is the stale copy and goes;
    # the profile in use is left exactly as it was.
    New-OldProfile $repair 'a stale profile'
    Remove-Item -LiteralPath (Join-Path $repair 'lib/core.dll')
    Run-Setup Install $repair $p2
    Assert (-not (Test-Path -LiteralPath (Join-Path $repair 'Nendo.Desktop.exe.WebView2'))) 'An old browser profile was kept beside a newer one.'
    Assert ((Get-Content -LiteralPath $movedDraft -Raw) -eq 'an unsaved Garden draft') 'Removing a stale old profile changed the profile in use.'
    Assert ((Get-Content -LiteralPath (Join-Path $repair 'lib/core.dll') -Raw) -eq 'repair core two') 'An upgrade over a missing owned file did not install the new payload.'
    Assert ((Get-Content -LiteralPath (Join-Path "$repair.previous" 'app.txt') -Raw) -eq 'repair one') 'An upgrade over a missing owned file kept no backup of what was there.'
    Assert (-not (Test-Path -LiteralPath (Join-Path "$repair.previous" 'lib/core.dll'))) 'The backup claims a file the install no longer had.'
    # A backup interrupted before it was complete is cleared by the next run, which then
    # keeps a complete one: built under .partial ...
    [void][IO.Directory]::CreateDirectory("$repair.previous.partial")
    Copy-Item -LiteralPath (Join-Path $repair 'app.txt') -Destination (Join-Path "$repair.previous.partial" 'app.txt')
    # And an older build run by hand from the backup left its profile there, which must
    # not make the backup unrecognized files.
    New-OldProfile "$repair.previous" 'a profile beside the backup'
    Run-Setup Install $repair $p1
    Assert (-not (Test-Path -LiteralPath (Join-Path "$repair.previous" 'Nendo.Desktop.exe.WebView2'))) 'A browser profile left in the backup survived the upgrade.'
    Assert (-not (Test-Path -LiteralPath "$repair.previous.partial")) 'An interrupted backup under .partial survived the next upgrade.'
    Assert ((Get-Content -LiteralPath (Join-Path "$repair.previous" 'app.txt') -Raw) -eq 'repair two') 'The upgrade after an interrupted backup kept no complete backup.'
    Assert (Test-Path -LiteralPath (Join-Path "$repair.previous" 'nendo-install.json')) 'The backup was completed without its inventory.'
    # ... or a Nendo.previous with no inventory, which an earlier setup left. One whose
    # files are not the installed payload is still retained for review.
    Remove-Item -LiteralPath (Join-Path "$repair.previous" 'nendo-install.json')
    Run-Setup Install $repair $p2 $false
    Assert (Test-Path -LiteralPath (Join-Path "$repair.previous" 'app.txt')) 'A backup holding unknown bytes was not retained for review.'
    Remove-Item -LiteralPath "$repair.previous" -Recurse -Force
    [void][IO.Directory]::CreateDirectory("$repair.previous")
    Copy-Item -LiteralPath (Join-Path $repair 'app.txt') -Destination (Join-Path "$repair.previous" 'app.txt')
    Run-Setup Install $repair $p2
    Assert ((Get-Content -LiteralPath (Join-Path "$repair.previous" 'app.txt') -Raw) -eq 'repair one') 'A backup left without an inventory blocked the next upgrade.'
    # Uninstall with an owned file held open, as a loaded DLL is, refuses before it removes
    # anything -- of the install or of its backup -- and the same uninstall then finishes.
    $installedInventory = Get-Content -LiteralPath (Join-Path $repair 'nendo-install.json') -Raw | ConvertFrom-Json
    $heldPath = Join-Path $repair @($installedInventory.files)[-1].path
    $ownedBefore = @('app.txt', 'lib/core.dll', 'nendo-install.json') | ForEach-Object { Join-Path $repair $_; Join-Path "$repair.previous" $_ }
    New-OldProfile $repair 'kept while uninstall is refused'
    $held = [IO.File]::Open($heldPath, 'Open', 'Read', 'Read')
    try { Run-Setup Uninstall $repair '' $false } finally { $held.Dispose() }
    Assert (Test-Path -LiteralPath (Join-Path $repair 'Nendo.Desktop.exe.WebView2')) 'A refused uninstall moved or removed the old browser profile.'
    foreach ($path in $ownedBefore) { Assert (Test-Path -LiteralPath $path) "An uninstall refused over a file in use still removed $path." }
    # A Nendo started from the backup keeps setup out too, and the refusal says where a
    # Nendo whose window was closed still is.
    $fake = Join-Path "$repair.previous" 'Nendo.Desktop.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $fake
    $fakeProcess = Start-Process -FilePath $fake -ArgumentList '/d /c ping -n 120 127.0.0.1 >nul' -WindowStyle Hidden -PassThru
    try {
        Run-Setup Uninstall $repair '' $false
        Assert ($script:lastSetupOutput -match 'notification area') "The refusal over a running Nendo does not say it may be in the notification area:`n$($script:lastSetupOutput)"
    } finally {
        # The tree, so the ping the stand-in started goes with it.
        if (-not $fakeProcess.HasExited) { & taskkill.exe /T /F /PID $fakeProcess.Id 2>&1 | Out-Null; [void]$fakeProcess.WaitForExit(10000) }
    }
    foreach ($path in $ownedBefore) { Assert (Test-Path -LiteralPath $path) "An uninstall refused over a running Nendo still removed $path." }
    Remove-Item -LiteralPath $fake -Force
    Remove-Item -LiteralPath (Join-Path $repair 'lib/core.dll')
    # An unfinished backup that is not the installed payload is left for review, and does
    # not stop the uninstall. And a profile that cannot be moved -- here the destination's
    # parent is a file -- stays where it was rather than being lost.
    [void][IO.Directory]::CreateDirectory("$repair.previous.partial")
    [IO.File]::WriteAllText((Join-Path "$repair.previous.partial" 'stranger.txt'), 'not the installed payload')
    $blocker = Join-Path $evidence 'profile-blocker'
    [IO.File]::WriteAllText($blocker, 'a file where a folder should be')
    $usualProfileRoot = $script:browserProfileRoot
    $script:browserProfileRoot = Join-Path $blocker 'WebView2'
    try { Run-Setup Uninstall $repair '' } finally { $script:browserProfileRoot = $usualProfileRoot }
    Assert (Test-Path -LiteralPath (Join-Path "$repair.previous.partial" 'stranger.txt')) 'Uninstall removed an unfinished backup that was not the installed payload.'
    $keptDraft = Join-Path $repair 'Nendo.Desktop.exe.WebView2\EBWebView\Default\Local Storage\leveldb.log'
    Assert ((Test-Path -LiteralPath $keptDraft) -and (Get-Content -LiteralPath $keptDraft -Raw) -eq 'kept while uninstall is refused') 'A browser profile that could not be moved was lost.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $repair 'app.txt'))) 'Uninstall over a missing owned file left the payload.'
    Assert (-not (Test-Path -LiteralPath "$repair.previous")) 'Uninstall over a missing owned file left the backup.'
    # A profile or AppData moved with a junction: links above the install root do not
    # stop setup, and a link inside it still does.
    $junctionTarget = Join-Path $evidence 'junction-target'
    [void][IO.Directory]::CreateDirectory($junctionTarget)
    $junction = Join-Path $evidence 'linked-parent'
    $null = New-Item -ItemType Junction -Path $junction -Value $junctionTarget
    $innerTarget = Join-Path $evidence 'inner-target'
    [void][IO.Directory]::CreateDirectory($innerTarget)
    $linkedRoot = Join-Path $junction 'Nendo'
    $innerLink = Join-Path $linkedRoot 'inner-link'
    try {
        Run-Setup Install $linkedRoot $p1
        Assert ((Get-Content -LiteralPath (Join-Path $linkedRoot 'app.txt') -Raw) -eq 'repair one') 'Setup did not install into a root reached through a junction.'
        $null = New-Item -ItemType Junction -Path $innerLink -Value $innerTarget
        Run-Setup Install $linkedRoot $p2 $false
        Assert ($script:lastSetupOutput -match 'Linked paths are not supported') "A link inside the install root was not refused:`n$($script:lastSetupOutput)"
        [IO.Directory]::Delete($innerLink, $false)
        Run-Setup Uninstall $linkedRoot ''
        Assert (-not (Test-Path -LiteralPath (Join-Path $junctionTarget 'Nendo'))) 'Uninstall through a junction left the payload.'
    } finally {
        if (Test-Path -LiteralPath $innerLink) { [IO.Directory]::Delete($innerLink, $false) }
        [IO.Directory]::Delete($junction, $false)
    }
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
@{result='passed'; checks=@('fresh install','changed-version upgrade','same-version reinstall','application rollback/user-file retention','injected staging-capacity boundaries','one previous payload','stale owned removal','locked-file refusal','unowned collision refusal','corrupt extraction refusal','interrupted update recovery','uninstall/user-file retention','moved payload and linked backup by file identity','recovery over a linked backup','registration failure then rerun repairs association and shortcut, backup retained','path traversal refusal','account registrations untouched','empty folder of a removed owned file removed','running-process predicate across sessions','identical-payload comparison within its time bound','missing owned file restored by the same payload and no veto on upgrade or uninstall','earlier browser profile moved once, kept by refusals and by a move that fails, stale copy removed, also from the backup','uninstall keeps an unfinished backup that is not the payload','interrupted backup cleared and replaced','uninstall refuses over a file in use before removing anything','a Nendo running from the backup refused with the notification-area sentence','install and uninstall through a junction above the root, link inside refused','backup folder held for a second is waited out, held past the retries refused before anything changes'); shell='Windows PowerShell 5.1'; capacityLimitation='Injected measurements at the production predicate; no physical disk exhaustion.'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'results.json')
Write-Output "Nendo setup checks passed: $evidence"
