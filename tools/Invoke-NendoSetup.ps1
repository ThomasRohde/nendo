# Windows PowerShell 5.1 compatible; bundled by the NSIS installer.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Install', 'Uninstall', 'Recover', 'RetirePilots')][string] $Mode,
    [Parameter(Mandatory)][string] $InstallRoot,
    [string] $PayloadRoot,
    [ValidatePattern('^[0-9a-f]{16}$')][string] $LegacyId,
    # Where the file association is written. The real one is the per-user class
    # store; a test passes a key of its own so that exercising this never hijacks
    # what .nendo opens with on the machine running the test.
    [string] $ClassesRoot = 'HKCU:\Software\Classes',
    # Where the Start Menu shortcut is written, for the same reason: a test passes a
    # folder of its own rather than putting an entry in the real Start Menu.
    [string] $StartMenuRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),
    # The installer extracts into a folder it deletes when it exits, so it asks for the
    # files to be moved into place. On one volume a move is a rename; the copy it
    # replaces wrote the whole payload a second time. Without it the payload is kept.
    [switch] $MovePayload,
    # Setup runs hidden under the installer. Each step it reports is also appended
    # here, so a failure can still be read after the installer window has closed.
    [string] $LogPath,
    # A failure's own sentence, written here as UTF-16 so the installer can show it in
    # its message box instead of one fixed text for every refusal.
    [string] $FailurePath,
    # Where the application keeps its browser profile, which setup moves an older
    # version's profile into. The default is the application's own default
    # (DesktopBrowserProfile, a Release build with no device-state override, which
    # DesktopBrowserProfileTests pins against this line); a test passes a folder of its
    # own so that exercising the move never reaches this account's real profile.
    [string] $BrowserProfileRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Nendo\WebView2')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A setup launched from pwsh can inherit PowerShell 7 module paths. Load the
# inbox Windows PowerShell modules explicitly instead of resolving that mixture.
Import-Module "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -Force
Import-Module "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1" -Force
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$previous = "$root.previous"
# The backup is built under this name and takes the name above only once complete, so
# an interrupted backup is never a Nendo.previous that every later run refuses.
$partial = "$previous.partial"
$inventoryName = 'nendo-install.json'
$pendingName = 'nendo-update.json'

function Add-SetupLog([string] $Text) {
    if (-not $LogPath) { return }
    # A log that cannot be written is not a failed install.
    try { Add-Content -LiteralPath $LogPath -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Text) -Encoding UTF8 } catch { }
}
# The installer shows these lines as they arrive, so a long step says what it is doing.
function Write-Step([string] $Text) {
    Write-Output $Text
    Add-SetupLog $Text
}

function Assert-NendoSetupCapacity([long] $AvailableBytes, [long] $PayloadBytes, [long] $PreviousBytes) {
    if ($AvailableBytes -lt 0 -or $PayloadBytes -lt 0 -or $PreviousBytes -lt 0) { throw 'Invalid setup capacity measurement.' }
    # Extraction has already completed. Reserve the replacement, retained original,
    # inventory/journal writes and a conservative 16 MiB margin before rotating backups.
    $required = [decimal]$PayloadBytes + [decimal]$PreviousBytes + 16MB
    if ([decimal]$AvailableBytes -lt $required) {
        throw "Insufficient staging space: need $required bytes, available $AvailableBytes. Installed and previous payloads were not changed."
    }
}

function Get-NendoPayloadBytes([string] $Directory, $Inventory) {
    [decimal]$total = 0
    if ($null -ne $Inventory) {
        foreach ($entry in $Inventory.files) {
            $file = Resolve-Owned $Directory $entry.path
            if (Test-Path -LiteralPath $file -PathType Leaf) { $total += (Get-Item -LiteralPath $file).Length }
        }
    }
    if ($total -gt [long]::MaxValue) { throw 'Payload size exceeds the supported staging capacity.' }
    return [long]$total
}

# Links are refused in the trees setup writes and removes -- the install root, its
# backup and the payload, each folder itself included -- because a link there could
# carry a removal somewhere else. A link above them cannot: Resolve-Owned keeps every
# owned path inside its directory. So a profile or AppData moved to another drive with
# a junction installs and uninstalls like any other.
function Assert-Tree([string] $Directory) {
    if (-not (Test-Path -LiteralPath $Directory)) { return }
    if ((Get-Item -LiteralPath $Directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked paths are not supported: $Directory" }
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Recurse -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked paths are not supported: $($entry.FullName)" }
    }
}
# Get-FileHash is a script function in Windows PowerShell 5.1 and costs about three
# times the hashing itself per file, and an upgrade hashes every file three times.
$sha256 = [Security.Cryptography.SHA256]::Create()
function Get-NendoFileHash([string] $Path) {
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
    try { return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose() }
}
function Resolve-Owned([string] $Directory, [string] $Relative) {
    if (-not $Relative -or $Relative -match '(^[\\/]|[:*?"<>|]|(^|[\\/])\.{1,2}([\\/]|$)|[ .]($|[\\/]))') { throw "Unsafe payload path: $Relative" }
    $full = [IO.Path]::GetFullPath((Join-Path $Directory $Relative))
    if (-not $full.StartsWith($Directory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload escapes its directory.' }
    return $full
}
function Read-Inventory([string] $Directory) {
    $file = Join-Path $Directory $inventoryName
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $value = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($value.schemaVersion -ne 1 -or $value.product -ne 'Nendo') { throw 'Unrecognized installation inventory.' }
    $seen = @{}
    foreach ($entry in $value.files) {
        $null = Resolve-Owned $Directory $entry.path
        if ($entry.path -in @($inventoryName, $pendingName) -or $seen.ContainsKey($entry.path) -or $entry.sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'Invalid installation inventory.' }
        $seen[$entry.path] = $true
    }
    return $value
}
# Changed bytes are an edit setup must not overwrite or delete. A file that is simply
# gone carries no edit, so a tree setup is about to replace or remove passes
# -AllowAbsent: a DLL quarantined or deleted since must not veto the repair, upgrade or
# uninstall that is the way back. A tree setup reads from -- the new payload, a backup
# it restores -- still needs every file.
function Assert-Bytes([string] $Directory, $Inventory, [switch] $AllowAbsent) {
    foreach ($entry in $Inventory.files) {
        $file = Resolve-Owned $Directory $entry.path
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            if ($AllowAbsent -and -not (Test-Path -LiteralPath $file)) { continue }
            throw "Payload differs; retained for recovery: $file"
        }
        if ((Get-NendoFileHash $file) -ne $entry.sha256) { throw "Payload differs; retained for recovery: $file" }
    }
}
# Nothing is removed or replaced until every owned file of the tree can be: a file in
# use refuses here, before the first deletion, rather than half-way through a removal.
function Assert-Unlocked([string] $Directory, $Inventory) {
    $handles = @()
    try {
        foreach ($entry in $Inventory.files) {
            $file = Resolve-Owned $Directory $entry.path
            if (Test-Path -LiteralPath $file -PathType Leaf) { $handles += [IO.File]::Open($file, 'Open', 'ReadWrite', 'None') }
        }
    } catch [IO.IOException] {
        throw "A Nendo file is in use, so nothing was removed or replaced. Close Nendo and run setup again. $($_.Exception.Message)"
    } finally { foreach ($handle in $handles) { $handle.Dispose() } }
}
function Copy-Owned([string] $From, [string] $To, $Inventory) {
    foreach ($entry in $Inventory.files) {
        $target = Resolve-Owned $To $entry.path
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
        # The target can share its bytes with the backup (see Save-Backup). Copying
        # over it would write into the backup too, so the old name goes first.
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
        Copy-Item -LiteralPath (Resolve-Owned $From $entry.path) -Destination $target -Force
    }
    Assert-Bytes $To $Inventory
}
# The backup is a hard link per file, not a copy: the bytes were checked a moment ago
# and are not written again. Setup never writes into an installed file -- it removes
# the name and puts the new file in its place -- so the backup keeps the old bytes. A
# volume without hard links gets a checked copy instead.
#
# A file already gone from the install has nothing to keep, and the backup's inventory
# lists only what the backup holds, so restoring from it never looks for a file it lacks.
function Save-Backup([string] $From, [string] $To, $Inventory) {
    [void][IO.Directory]::CreateDirectory($To)
    $copied = $false
    $kept = @()
    foreach ($entry in $Inventory.files) {
        $source = Resolve-Owned $From $entry.path
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $target = Resolve-Owned $To $entry.path
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
        try { $null = New-Item -ItemType HardLink -Path $target -Value $source -ErrorAction Stop }
        catch { Copy-Item -LiteralPath $source -Destination $target -Force; $copied = $true }
        $kept += $entry
    }
    $backup = $Inventory | ConvertTo-Json -Depth 6 | ConvertFrom-Json
    $backup.files = @($kept)
    if ($copied) { Assert-Bytes $To $backup }
    $backup | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $To $inventoryName) -Encoding UTF8
}
# A backup interrupted before it was complete: one built under .partial, or a
# Nendo.previous with no inventory that an earlier setup left. Every file in it was
# linked or copied from the installed payload, so it is removed when each one still
# matches an installed file. Anything else is retained for review, as before: an
# install refuses over it, and an uninstall (-Retain) leaves it and says so, since
# removing Nendo does not need that folder gone.
function Clear-UnfinishedBackup([string] $Directory, $Installed, [switch] $Retain) {
    if (-not (Test-Path -LiteralPath $Directory)) { return }
    Assert-Tree $Directory
    $known = @{}
    if ($null -ne $Installed) { foreach ($entry in $Installed.files) { $known[(Resolve-Owned $Directory $entry.path)] = $entry.sha256 } }
    $inventoryFile = Join-Path $Directory $inventoryName
    # A browser profile an older build left there is not part of the backup; the profile
    # step moves it once the run is going ahead.
    $profilePrefix = (Join-Path $Directory $legacyProfileName) + '\'
    $files = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Force |
        Where-Object { -not $_.FullName.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase) })
    foreach ($file in $files) {
        if ($file.FullName -eq $inventoryFile) { continue }
        if (-not $known.ContainsKey($file.FullName) -or (Get-NendoFileHash $file.FullName) -ne $known[$file.FullName]) {
            $message = "An unfinished backup holds files that are not the installed payload; retained for review: $Directory"
            if ($Retain) { Write-Step $message; return }
            throw $message
        }
    }
    Write-Step 'Removing an unfinished backup.'
    foreach ($file in $files) { Remove-Item -LiteralPath $file.FullName -Force }
    Remove-EmptyDirectories $Directory
}
# Moved files are not hashed again: a move does not rewrite them, and the payload was
# checked in this run before anything changed.
function Install-Owned([string] $From, [string] $To, $Inventory) {
    if (-not $MovePayload) { Copy-Owned $From $To $Inventory; return }
    foreach ($entry in $Inventory.files) {
        $target = Resolve-Owned $To $entry.path
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
        [IO.File]::Move((Resolve-Owned $From $entry.path), $target)
    }
}
function Remove-EmptyDirectories([string] $Directory) {
    if (-not (Test-Path -LiteralPath $Directory)) { return }
    foreach ($dir in @(Get-ChildItem -LiteralPath $Directory -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending) + @(Get-Item -LiteralPath $Directory)) {
        if (@(Get-ChildItem -LiteralPath $dir.FullName -Force).Count -eq 0) { [IO.Directory]::Delete($dir.FullName, $false) }
    }
}
# The folders a removed file leaves empty go with it, up to but never including the root.
function Remove-EmptyParents([string] $Directory, [string] $File) {
    $stop = $Directory.TrimEnd('\') + '\'
    $parent = Split-Path -Parent $File
    while ($parent -and $parent.StartsWith($stop, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $parent -PathType Container) -and @(Get-ChildItem -LiteralPath $parent -Force).Count -eq 0) {
        [IO.Directory]::Delete($parent, $false)
        $parent = Split-Path -Parent $parent
    }
}
# Callers check the tree's bytes and handles first, once, before anything goes. A file
# already absent counts as removed, so a removal stopped part-way finishes on a rerun.
function Remove-Owned([string] $Directory, $Inventory) {
    Assert-Tree $Directory
    foreach ($entry in $Inventory.files) {
        $file = Resolve-Owned $Directory $entry.path
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
    Remove-Item -LiteralPath (Join-Path $Directory $inventoryName) -Force
    Remove-EmptyDirectories $Directory
}
# Nendo kept its browser profile beside the executable until the profile moved under
# the device-state folder. That folder was never owned payload, so uninstall kept it
# for good and every run walked it. It holds a view's unsaved drafts and settings (the
# Garden and Swarm keep them in page storage), so it is moved to where the application
# now looks, once, rather than deleted. Only when a profile is already there -- this
# version has run since -- is the old one removed, as the newer one is what Nendo uses.
# A move that fails, across volumes or over a file still in use, is a rename that never
# happened: the old folder stays where it was, and the next run tries again.
$legacyProfileName = 'Nendo.Desktop.exe.WebView2'
function Move-LegacyBrowserProfile([string] $Directory) {
    $browserProfile = Join-Path $Directory $legacyProfileName
    if (-not (Test-Path -LiteralPath $browserProfile -PathType Container)) { return }
    try { Assert-Tree $browserProfile }
    catch { Write-Step "The earlier browser profile holds a link and was left in place. $($_.Exception.Message)"; return }
    if (-not (Test-Path -LiteralPath $BrowserProfileRoot)) {
        try {
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $BrowserProfileRoot))
            [IO.Directory]::Move($browserProfile, $BrowserProfileRoot)
            Write-Step "Moved the browser profile an earlier version kept beside the application to $BrowserProfileRoot."
        } catch {
            Write-Step "The earlier browser profile could not be moved and was left in place; setup tries again next time. $($_.Exception.Message)"
        }
        Remove-IfEmpty $Directory
        return
    }
    try {
        [IO.Directory]::Delete($browserProfile, $true)
        Write-Step 'Removed the browser profile an earlier version kept beside the application; a newer one is in use.'
    } catch {
        Write-Step "The earlier browser profile was retained; setup carried on. $($_.Exception.Message)"
    }
    Remove-IfEmpty $Directory
}
# A folder the profile was the last thing in -- an uninstalled root, an emptied backup --
# goes with it. Never a sweep: a live install folder is left exactly as it is.
function Remove-IfEmpty([string] $Directory) {
    if ((Test-Path -LiteralPath $Directory -PathType Container) -and @(Get-ChildItem -LiteralPath $Directory -Force).Count -eq 0) {
        [IO.Directory]::Delete($Directory, $false)
    }
}
# Whether two inventories name the same payload. One lookup per entry: comparing every
# entry with every other cost seconds on a repair of a 700-file payload.
function Test-SamePayload($Old, $Next) {
    if ($null -eq $Old -or @($Old.files).Count -ne @($Next.files).Count) { return $false }
    $installed = @{}
    foreach ($entry in $Old.files) { $installed[$entry.path] = $entry.sha256 }
    foreach ($entry in $Next.files) {
        if (-not $installed.ContainsKey($entry.path) -or $installed[$entry.path] -ne $entry.sha256) { return $false }
    }
    return $true
}
# What a .nendo file is, to Windows Explorer.
#
# Written here rather than in the NSIS script for one reason: this script is what
# Test-NendoSetupIsolated.ps1 runs, and the NSIS script is what nothing runs on a
# machine that already has Nendo installed. A registration nobody can exercise is
# a registration nobody has seen work.
#
# Per-user throughout. The install is per-user, so the association is too: no
# elevation, and uninstalling takes it away again for this account only.
$progId = 'Nendo.Document'
$extension = '.nendo'
$applicationKey = 'Applications\Nendo.Desktop.exe'
# The shell identity the application sets on itself before its first window. Windows
# groups taskbar buttons by it, files the Jump List under it, and attributes
# notifications to it, so it has to be the same string in three places: here, the
# Start Menu shortcut, and DesktopShellIdentity.DefaultAppUserModelId.
$appUserModelId = 'Nendo.Desktop'
$shortcutName = 'Nendo.lnk'

# A named value that may not be there. Under Set-StrictMode reading a missing one
# off an object that does exist throws about PowerShell rather than about the
# registration, which is the failure mode F-076 records.
function Get-NendoRegistryValue([string] $Key, [string] $Name) {
    if (-not (Test-Path -LiteralPath $Key)) { return $null }
    $property = Get-ItemProperty -LiteralPath $Key -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $property) { return $null }
    return [string]$property.$Name
}

function Set-NendoRegistryDefault([string] $Key, [string] $Value) {
    if (-not (Test-Path -LiteralPath $Key)) { [void](New-Item -Path $Key -Force) }
    [void](New-ItemProperty -LiteralPath $Key -Name '(default)' -Value $Value -PropertyType String -Force)
}

function Set-NendoFileAssociation([string] $Classes, [string] $InstallDirectory) {
    $executable = Join-Path $InstallDirectory 'Nendo.Desktop.exe'
    $icon = Join-Path $InstallDirectory 'Assets\DocumentIcon.ico'
    # A document icon rather than the application icon, so a folder of files does
    # not read as a folder of applications.
    if (-not (Test-Path -LiteralPath $icon)) { $icon = Join-Path $InstallDirectory 'Assets\AppIcon.ico' }
    $command = '"' + $executable + '" "%1"'

    Set-NendoRegistryDefault (Join-Path $Classes $progId) 'Nendo application'
    Set-NendoRegistryDefault (Join-Path $Classes "$progId\DefaultIcon") ('"' + $icon + '",0')
    Set-NendoRegistryDefault (Join-Path $Classes "$progId\shell\open\command") $command
    # The verb's own name, so the context menu reads "Open" rather than "open".
    Set-NendoRegistryDefault (Join-Path $Classes "$progId\shell\open") 'Open'

    # "New > Nendo application" in the Explorer context menu. A command rather than a
    # template file: Explorer picks the name and Nendo makes a real empty file at it.
    # A template would be a second answer to what an empty file is, shipped in the
    # payload and kept in step with the one New file already produces.
    $shellNew = Join-Path $Classes "$extension\ShellNew"
    if (-not (Test-Path -LiteralPath $shellNew)) { [void](New-Item -Path $shellNew -Force) }
    [void](New-ItemProperty -LiteralPath $shellNew -Name 'Command' -Value ('"' + $executable + '" -new "%1"') -PropertyType String -Force)

    # What the notification centre calls Nendo, and what it draws beside a
    # notification. Unpackaged applications have no manifest to say either, so the
    # identity the process sets on itself needs a registration to be legible.
    $identity = Join-Path $Classes "AppUserModelId\$appUserModelId"
    if (-not (Test-Path -LiteralPath $identity)) { [void](New-Item -Path $identity -Force) }
    [void](New-ItemProperty -LiteralPath $identity -Name 'DisplayName' -Value 'Nendo' -PropertyType String -Force)
    [void](New-ItemProperty -LiteralPath $identity -Name 'IconUri' -Value (Join-Path $InstallDirectory 'Assets\AppIcon.ico') -PropertyType String -Force)

    Set-NendoRegistryDefault (Join-Path $Classes $extension) $progId
    # OpenWithProgids is what puts Nendo in the Open with list and in "Choose
    # another app", and what lets Windows offer it back if another program takes
    # the extension over.
    $openWith = Join-Path $Classes "$extension\OpenWithProgids"
    if (-not (Test-Path -LiteralPath $openWith)) { [void](New-Item -Path $openWith -Force) }
    [void](New-ItemProperty -LiteralPath $openWith -Name $progId -Value '' -PropertyType String -Force)

    # And the same under the executable's own key, so Open with reaches Nendo even
    # for a file whose extension somebody else owns.
    Set-NendoRegistryDefault (Join-Path $Classes "$applicationKey\shell\open\command") $command
    $supported = Join-Path $Classes "$applicationKey\SupportedTypes"
    if (-not (Test-Path -LiteralPath $supported)) { [void](New-Item -Path $supported -Force) }
    [void](New-ItemProperty -LiteralPath $supported -Name $extension -Value '' -PropertyType String -Force)

    Publish-NendoAssociationChange
    Write-Step "Registered $extension with Windows for this user."
}

function Remove-NendoFileAssociation([string] $Classes, [string] $InstallDirectory) {
    # The identity key is not only ours by the time we remove it: Windows adds a
    # CustomActivator to it the first time notifications register, and that names a
    # CLSID key elsewhere in the class store. Deleting the identity alone leaves that
    # CLSID pointing at an executable that is about to be removed, and the next
    # install mints a new one -- an orphan per reinstall.
    $identityKey = Join-Path $Classes "AppUserModelId\$appUserModelId"
    $activator = Get-NendoRegistryValue $identityKey 'CustomActivator'
    if ($activator) {
        $activatorKey = Join-Path $Classes "CLSID\$activator"
        if (Test-Path -LiteralPath $activatorKey) { Remove-Item -LiteralPath $activatorKey -Recurse -Force }
    }
    # The New entry is surrendered only while it still launches this install, for the
    # reason the extension key is: another program may own it now.
    $shellNewKey = Join-Path $Classes "$extension\ShellNew"
    $command = Get-NendoRegistryValue $shellNewKey 'Command'
    if (-not $command) { $shellNewKey = $null }
    elseif (-not $command.StartsWith('"' + $InstallDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Step "The New menu entry launches something else and was retained: $command"
        $shellNewKey = $null
    }
    foreach ($key in @(
        (Join-Path $Classes $progId),
        (Join-Path $Classes $applicationKey),
        $shellNewKey,
        $identityKey)) {
        if ($key -and (Test-Path -LiteralPath $key)) { Remove-Item -LiteralPath $key -Recurse -Force }
    }
    $openWith = Join-Path $Classes "$extension\OpenWithProgids"
    if (Test-Path -LiteralPath $openWith) {
        Remove-ItemProperty -LiteralPath $openWith -Name $progId -Force -ErrorAction SilentlyContinue
    }
    # The extension key itself is only surrendered if it still points at Nendo.
    # Another program may have taken it over since, and taking it back on the way
    # out would be this uninstaller changing something that is not its own.
    $extensionKey = Join-Path $Classes $extension
    if (Test-Path -LiteralPath $extensionKey) {
        $current = (Get-ItemProperty -LiteralPath $extensionKey -ErrorAction SilentlyContinue).'(default)'
        if ($current -eq $progId) {
            [void](New-ItemProperty -LiteralPath $extensionKey -Name '(default)' -Value '' -PropertyType String -Force)
        }
    }
    Publish-NendoAssociationChange
    Write-Step "Removed the $extension association for this user."
}

# The Start Menu shortcut, and the one property on it that matters.
#
# Written here rather than by the NSIS script, for the reason the association is:
# the NSIS script is what nothing runs on a machine that already has Nendo, and a
# shortcut nobody can exercise is a shortcut nobody has seen work. It takes a
# -StartMenuRoot so a test writes into a folder of its own.
#
# System.AppUserModel.ID is the property. Windows groups a taskbar button by the
# identity on the window and a pinned shortcut by the identity on the shortcut, so an
# application that names itself and a shortcut that does not is the one combination
# worse than neither: the pinned copy and the running window become two buttons.
function Get-NendoShortcutWriter {
    if ('NendoShortcut' -as [type]) { return }
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NendoShortcut
{
    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
        public PropertyKey(Guid formatId, uint propertyId) { FormatId = formatId; PropertyId = propertyId; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        public ushort Type;
        public ushort Reserved1;
        public ushort Reserved2;
        public ushort Reserved3;
        public IntPtr Pointer;
        public IntPtr Padding;
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out ushort pwHotkey);
        void SetHotkey(ushort wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    [DllImport("propsys.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void PropVariantToStringAlloc(ref PropVariant pv, out IntPtr value);

    [DllImport("ole32.dll", PreserveSig = false)]
    private static extern void PropVariantClear(ref PropVariant pv);

    private static PropertyKey AppUserModelIdKey()
    {
        return new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    }

    public static void Write(string linkPath, string target, string iconPath, string description, string appUserModelId)
    {
        IShellLinkW link = (IShellLinkW)new ShellLink();
        link.SetPath(target);
        link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(target));
        link.SetIconLocation(iconPath, 0);
        link.SetDescription(description);
        IPropertyStore store = (IPropertyStore)link;
        PropertyKey key = AppUserModelIdKey();
        // The PROPVARIANT is built here rather than by InitPropVariantFromString, which
        // looks like an API and is not: it is an inline function in propvarutil.h with no
        // export behind it, so calling it through a DllImport fails at the first call.
        PropVariant value = new PropVariant();
        try
        {
            value.Type = 31; // VT_LPWSTR. PropVariantClear frees the string below.
            value.Pointer = Marshal.StringToCoTaskMemUni(appUserModelId);
            store.SetValue(ref key, ref value);
            store.Commit();
        }
        finally
        {
            PropVariantClear(ref value);
        }
        ((IPersistFile)link).Save(linkPath, true);
    }

    public static string Target(string linkPath)
    {
        IShellLinkW link = (IShellLinkW)new ShellLink();
        ((IPersistFile)link).Load(linkPath, 0);
        System.Text.StringBuilder buffer = new System.Text.StringBuilder(1024);
        link.GetPath(buffer, buffer.Capacity, IntPtr.Zero, 0);
        return buffer.ToString();
    }

    public static string AppUserModelId(string linkPath)
    {
        IShellLinkW link = (IShellLinkW)new ShellLink();
        ((IPersistFile)link).Load(linkPath, 0);
        IPropertyStore store = (IPropertyStore)link;
        PropertyKey key = AppUserModelIdKey();
        PropVariant value = new PropVariant();
        IntPtr text = IntPtr.Zero;
        try
        {
            store.GetValue(ref key, out value);
            if (value.Type == 0) { return null; }
            PropVariantToStringAlloc(ref value, out text);
            return Marshal.PtrToStringUni(text);
        }
        finally
        {
            if (text != IntPtr.Zero) { Marshal.FreeCoTaskMem(text); }
            PropVariantClear(ref value);
        }
    }
}
'@
}

function Set-NendoStartMenuShortcut([string] $StartMenu, [string] $InstallDirectory) {
    Get-NendoShortcutWriter
    [void][IO.Directory]::CreateDirectory($StartMenu)
    $link = Join-Path $StartMenu $shortcutName
    [NendoShortcut]::Write($link,
        (Join-Path $InstallDirectory 'Nendo.Desktop.exe'),
        (Join-Path $InstallDirectory 'Assets\AppIcon.ico'),
        'Nendo',
        $appUserModelId)
    Write-Step "Start Menu shortcut written: $link"
}

function Remove-NendoStartMenuShortcut([string] $StartMenu, [string] $InstallDirectory) {
    $link = Join-Path $StartMenu $shortcutName
    if (-not (Test-Path -LiteralPath $link)) { return }
    # Only ours. A shortcut of the same name pointing somewhere else belongs to
    # somebody, and deleting it would be this uninstaller removing what it did not
    # write -- the same rule the extension key follows.
    try {
        Get-NendoShortcutWriter
        $target = [NendoShortcut]::Target($link)
    } catch {
        Write-Step "The Start Menu shortcut could not be read and was retained. $($_.Exception.Message)"
        return
    }
    $expected = Join-Path $InstallDirectory 'Nendo.Desktop.exe'
    if ($target -ne $expected) {
        Write-Step "The Start Menu shortcut points elsewhere and was retained: $target"
        return
    }
    Remove-Item -LiteralPath $link -Force
    Write-Step "Removed the Start Menu shortcut."
}

# Explorer caches what it knows about a file type. Without this the new icon
# appears after a sign-out rather than at once.
function Publish-NendoAssociationChange {
    try {
        if (-not ('NendoShellNotify' -as [type])) {
            Add-Type -Namespace '' -Name 'NendoShellNotify' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(int eventId, uint flags, System.IntPtr item1, System.IntPtr item2);
'@
        }
        # SHCNE_ASSOCCHANGED, SHCNF_IDLIST
        [NendoShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    } catch {
        # A refused notification is a stale icon, not a failed install. Say so and
        # carry on rather than failing setup over a redraw.
        Write-Step "Windows was not told the association changed; the icon may take a sign-out to appear. $($_.Exception.Message)"
    }
}

# Everything setup tells Windows, after the payload is in place. Idempotent: each
# value is written with -Force and the shortcut is saved over whatever is there, so
# running it again over a complete registration changes nothing and running it over
# a partial one completes it. That is what lets a rerun of the same installer repair
# a registration that failed after the payload landed.
function Register-NendoWithWindows {
    Write-Step 'Registering Nendo with Windows.'
    Set-NendoFileAssociation $ClassesRoot $root
    Set-NendoStartMenuShortcut $StartMenuRoot $root
}

# Whether a running Nendo.Desktop keeps setup out. A process in another sign-in session
# belongs to another account: this account cannot read its path, and its per-user
# install is not this one. An unreadable path in this session still refuses, because it
# could be this install.
function Test-NendoProcessBlocks([string] $Path, [int] $SessionId, [int] $CurrentSession, [string[]] $Roots) {
    if ($SessionId -ne $CurrentSession) { return $false }
    if (-not $Path) { return $true }
    foreach ($folder in $Roots) {
        if ($Path.StartsWith($folder.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}
# The backup is removed file by file too, so a Nendo started from it keeps setup out
# as one started from the install does.
function Assert-Closed {
    $folders = @($root, $previous)
    if ($Mode -eq 'RetirePilots') { $folders += (Join-Path $env:LOCALAPPDATA 'Programs\NendoPilot') }
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    foreach ($process in @(Get-Process -Name 'Nendo.Desktop' -ErrorAction SilentlyContinue)) {
        if (Test-NendoProcessBlocks $process.Path $process.SessionId $session $folders) {
            # Closing the window leaves Nendo in the notification area, so a person who
            # closed it is told where it still is.
            throw 'Nendo is still running. Closing its window leaves it in the notification area: choose Exit Nendo from its icon there, then run setup again.'
        }
    }
}
function Restore-Pending {
    $journalPath = Join-Path $root $pendingName
    if (-not (Test-Path -LiteralPath $journalPath)) { return }
    $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
    if ($journal.product -ne 'Nendo' -or $journal.schemaVersion -ne 1) { throw 'Unrecognized update journal; no files changed.' }
    $old = Read-Inventory $previous
    if ($journal.hadPrevious -and $null -eq $old) { throw 'Missing recovery payload.' }
    if ($null -ne $old) { Assert-Bytes $previous $old }
    $oldPaths = @{}
    if ($null -ne $old) { foreach ($entry in $old.files) { $oldPaths[$entry.path] = $entry.sha256 } }
    $newPaths = @{}
    foreach ($entry in $journal.files) {
        if ($entry.path -in @($inventoryName, $pendingName) -or $newPaths.ContainsKey($entry.path) -or $entry.sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'Invalid update journal.' }
        $newPaths[$entry.path] = $entry.sha256
    }
    # Validate every affected path before restoring anything. Never erase an external edit.
    foreach ($entry in $journal.files) {
        $file = Resolve-Owned $root $entry.path
        if (Test-Path -LiteralPath $file) {
            $hash = (Get-NendoFileHash $file)
            if ($hash -ne $entry.sha256 -and $hash -ne $oldPaths[$entry.path]) { throw "Update recovery found changed bytes: $file" }
        }
    }
    if ($null -ne $old) {
        foreach ($entry in $old.files) {
            $file = Resolve-Owned $root $entry.path
            if ((Test-Path -LiteralPath $file) -and -not $newPaths.ContainsKey($entry.path) -and (Get-NendoFileHash $file) -ne $entry.sha256) { throw "Recovery found an external edit: $file" }
        }
    }
    foreach ($entry in $journal.files) {
        $file = Resolve-Owned $root $entry.path
        if (-not $oldPaths.ContainsKey($entry.path) -and (Test-Path -LiteralPath $file)) { Remove-Item -LiteralPath $file -Force }
    }
    if ($null -ne $old) {
        Copy-Owned $previous $root $old
        Copy-Item -LiteralPath (Join-Path $previous $inventoryName) -Destination (Join-Path $root $inventoryName) -Force
    } elseif (Test-Path -LiteralPath (Join-Path $root $inventoryName)) {
        Remove-Item -LiteralPath (Join-Path $root $inventoryName)
    }
    Remove-Item -LiteralPath $journalPath
    Remove-EmptyDirectories $root
    Write-Step 'Recovered the previous application payload.'
}

$mutex = New-Object Threading.Mutex($false, 'Local\NendoSetup')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another Nendo setup is running.' }
    Assert-Tree $root
    Assert-Tree $previous
    Assert-Tree $partial
    Assert-Closed
    if ($Mode -eq 'RetirePilots') {
        $registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
        foreach ($key in @(Get-ChildItem -LiteralPath $registry | Where-Object { $_.PSChildName -cmatch '^NendoPilot-[0-9a-f]{16}$' })) {
            $id = $key.PSChildName.Substring(11)
            if ($LegacyId -and $id -ne $LegacyId) { continue }
            $legacy = Join-Path $env:LOCALAPPDATA "Programs\NendoPilot\$id"
            Assert-Tree $legacy
            $uninstaller = Join-Path $legacy 'Uninstall.exe'
            $registration = Get-ItemProperty -LiteralPath $key.PSPath
            if ($registration.UninstallString -ne ('"' + $uninstaller + '"') -or -not (Test-Path -LiteralPath $uninstaller)) { throw "Unrecognized pilot registration retained: $($key.PSChildName)" }
            # _?= runs the existing manifest-owned uninstaller synchronously at its validated path.
            $process = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$legacy" -WindowStyle Hidden -PassThru -Wait
            if ($process.ExitCode -ne 0 -or (Test-Path -LiteralPath $key.PSPath)) { throw 'A legacy pilot could not be retired; its remaining files were retained.' }
            if (Test-Path -LiteralPath $uninstaller) { Remove-Item -LiteralPath $uninstaller }
            # A pilot kept its browser profile beside its executable too.
            Move-LegacyBrowserProfile $legacy
            Remove-EmptyDirectories $legacy
            Write-Step "Retired pilot $id; unknown files retained."
        }
        return
    }
    Restore-Pending
    if ($Mode -eq 'Recover') { return }
    $old = Read-Inventory $root
    if ($Mode -eq 'Uninstall') {
        if ($null -eq $old) { throw 'No recognized Nendo installation; nothing removed.' }
        Write-Step 'Checking the installed files.'
        Assert-Bytes $root $old -AllowAbsent
        $backup = Read-Inventory $previous
        if ($null -ne $backup) { Assert-Bytes $previous $backup -AllowAbsent }
        # Every owned file of both trees can go before the first one does.
        Assert-Unlocked $root $old
        if ($null -ne $backup) { Assert-Unlocked $previous $backup }
        Clear-UnfinishedBackup $partial $old -Retain
        if ($null -eq $backup) { Clear-UnfinishedBackup $previous $old -Retain }
        if ($null -ne $backup) { Remove-Owned $previous $backup }
        Write-Step 'Removing Nendo.'
        Remove-Owned $root $old
        # Only now that Nendo is gone: a refused uninstall leaves the profile where it was.
        Move-LegacyBrowserProfile $root
        Move-LegacyBrowserProfile $previous
        Remove-NendoStartMenuShortcut $StartMenuRoot $root
        Remove-NendoFileAssociation $ClassesRoot $root
        Write-Step 'Nendo payload removed; unknown files and device settings retained.'
        return
    }
    $source = [IO.Path]::GetFullPath($PayloadRoot).TrimEnd('\')
    Assert-Tree $source
    $next = Read-Inventory $source
    if ($null -eq $next) { throw 'Missing setup payload inventory.' }
    # NSIS generates its uninstaller only at extraction time.
    $generatedUninstaller = Join-Path $source 'Uninstall.exe'
    if ((Test-Path -LiteralPath $generatedUninstaller) -and -not @($next.files | Where-Object { $_.path -eq 'Uninstall.exe' }).Count) {
        $next.files = @($next.files) + @([pscustomobject]@{path='Uninstall.exe'; sha256=(Get-NendoFileHash $generatedUninstaller)})
        $next | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $source $inventoryName) -Encoding UTF8
    }
    Write-Step 'Checking the new files.'
    Assert-Bytes $source $next
    if ($null -ne $old) { Write-Step 'Checking the installed files.'; Assert-Bytes $root $old -AllowAbsent }
    if (Test-SamePayload $old $next) {
        # A file gone from the installed payload -- quarantined, deleted -- comes back
        # from this one. Only absent names are written, so nothing installed is replaced
        # and a repair that stops part-way is finished by the next run.
        $missing = @($next.files | Where-Object { -not (Test-Path -LiteralPath (Resolve-Owned $root $_.path) -PathType Leaf) })
        if ($missing.Count -gt 0) {
            Write-Step "Restoring $($missing.Count) missing file(s) of the installed version."
            Install-Owned $source $root ([pscustomobject]@{ files = $missing })
        } else {
            Write-Step 'This Nendo payload is already installed; retained the previous version.'
        }
        # The payload is the one installed, but its registration may not be: the run
        # that installed it can have failed after the files landed and the journal was
        # removed, or somebody removed the shortcut or the association since. Register
        # again rather than report an install the Start Menu cannot find.
        Register-NendoWithWindows
        Move-LegacyBrowserProfile $root
        Move-LegacyBrowserProfile $previous
        Write-Step "Nendo installed: $root"
        return
    }
    Clear-UnfinishedBackup $partial $old
    if ($null -eq (Read-Inventory $previous)) { Clear-UnfinishedBackup $previous $old }
    $oldPaths = @{}
    if ($null -ne $old) { foreach ($entry in $old.files) { $oldPaths[$entry.path] = $true } }
    foreach ($entry in $next.files) {
        $target = Resolve-Owned $root $entry.path
        if ((Test-Path -LiteralPath $target) -and -not $oldPaths.ContainsKey($entry.path)) { throw "Unowned file collision; no files changed: $target" }
    }
    # A blocked/locked payload must fail before backup rotation or replacement.
    if ($null -ne $old) { Assert-Unlocked $root $old }
    $availableBytes = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root)).AvailableFreeSpace
    Assert-NendoSetupCapacity $availableBytes (Get-NendoPayloadBytes $source $next) (Get-NendoPayloadBytes $root $old)
    $backup = Read-Inventory $previous
    if ($null -ne $backup) {
        Assert-Bytes $previous $backup -AllowAbsent
        Assert-Unlocked $previous $backup
        Write-Step 'Removing the older backup.'
        Remove-Owned $previous $backup
    }
    # An older build run by hand from the backup kept its profile there, which would
    # otherwise make the backup look like unrecognized files and refuse every upgrade.
    # Every refusal above has passed, so this install is going ahead.
    Move-LegacyBrowserProfile $previous
    if (Test-Path -LiteralPath $previous) { throw 'Previous payload contains unrecognized files; retained for review.' }
    if ($null -ne $old) {
        Write-Step 'Keeping the installed version as a backup.'
        Save-Backup $root $partial $old
        # A folder cannot be renamed while any file in it is open, and a virus scanner opens the
        # executables just copied into it (the isolated lane once failed here with "Access to the
        # path ... is denied", then passed twice). Wait it out, briefly, before refusing.
        for ($attempt = 1; ; $attempt++) {
            try { [IO.Directory]::Move($partial, $previous); break }
            catch [System.IO.IOException], [System.UnauthorizedAccessException] {
                if ($attempt -ge 40) {
                    throw "The backup folder $partial stayed in use for 10 seconds, so the installed version was left as it was. Run setup again; a virus scanner lets go once it has read the files. ($($_.Exception.Message))"
                }
                Start-Sleep -Milliseconds 250
            }
        }
    }
    [void][IO.Directory]::CreateDirectory($root)
    @{schemaVersion=1; product='Nendo'; hadPrevious=($null -ne $old); files=@($next.files)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root $pendingName) -Encoding UTF8
    try {
        Write-Step 'Putting the new files in place.'
        Install-Owned $source $root $next
        $nextPaths = @{}
        foreach ($entry in $next.files) { $nextPaths[$entry.path] = $true }
        if ($null -ne $old) {
            foreach ($entry in $old.files) {
                if ($nextPaths.ContainsKey($entry.path)) { continue }
                $obsolete = Resolve-Owned $root $entry.path
                if (Test-Path -LiteralPath $obsolete) { Remove-Item -LiteralPath $obsolete }
                Remove-EmptyParents $root $obsolete
            }
        }
        Copy-Item -LiteralPath (Join-Path $source $inventoryName) -Destination (Join-Path $root $inventoryName) -Force
        Remove-Item -LiteralPath (Join-Path $root $pendingName)
    } catch {
        $failure = $_
        Restore-Pending
        throw $failure
    }
    # After the payload lands, so neither the association nor the shortcut points at
    # an executable that is not there yet. A failure here leaves the payload installed
    # and no journal behind; rerunning the same installer takes the identical-payload
    # path above, which registers again.
    Register-NendoWithWindows
    # Only once the install has landed: a refused or failed upgrade leaves the profile
    # where it was.
    Move-LegacyBrowserProfile $root
    Write-Step "Nendo installed: $root"
} catch {
    # The log and the installer's message box: the error itself already reaches the
    # installer's details list through stderr.
    Add-SetupLog "Setup failed: $($_.Exception.Message)"
    if ($FailurePath) {
        try { [IO.File]::WriteAllText($FailurePath, $_.Exception.Message, (New-Object Text.UnicodeEncoding($false, $false))) } catch { }
    }
    throw
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
