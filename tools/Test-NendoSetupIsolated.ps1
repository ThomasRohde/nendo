# The installer smoke refuses to run over an owner installation. This exercises
# the same setup logic the installer bundles, against a task-owned root, so the
# payload and the install/upgrade/uninstall semantics are verified without
# touching the owner's installation, registry registration or Start Menu shortcut.
#
# Not covered here, and still a clean-machine obligation: the NSIS bootstrapper
# itself, its payload extraction and the HKCU uninstall registration. Those are
# what Test-NendoInstaller.ps1 covers when a clean user exists.
[CmdletBinding()]
param(
    [string] $PilotRoot = 'artifacts/build/publish',
    # Keep the staged payload after a pass. It is a ~308 MB copy of an
    # already-verified payload, so it is pruned by default; pass this to inspect
    # what setup actually saw.
    [switch] $KeepStagedPayload)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pilot = (Resolve-Path -LiteralPath $PilotRoot).Path
$payload = Join-Path $pilot 'payload'
$manifest = Get-Content -LiteralPath (Join-Path $pilot 'manifest.json') -Raw | ConvertFrom-Json
$setup = Join-Path $PSScriptRoot 'Invoke-NendoSetup.ps1'
if (-not (Test-Path -LiteralPath $payload)) { throw "No published payload at $payload. Run Publish-NendoPayload.ps1 first." }
$inventorySource = Join-Path $pilot 'nendo-install.json'
if (-not (Test-Path -LiteralPath $inventorySource)) { throw "No payload inventory at $inventorySource. Run Build-NendoInstaller.ps1 first." }

$ownerRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs/Nendo'
$evidenceRoot = Join-Path $repoRoot ('artifacts/evidence/runs/p6-setup-isolated-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $evidenceRoot)
$installRoot = Join-Path $evidenceRoot 'install'
# The file association is written to a class store of this run's own. Pointing
# setup at HKCU:\Software\Classes would register .nendo against a throwaway
# install root and then unregister it, which is this lane reaching into what this
# account opens .nendo with -- the same line Test-NendoInstaller refuses to cross
# for files.
$classesRoot = "HKCU:\Software\Nendo-Isolated-Setup\$([Guid]::NewGuid().ToString('N'))\Classes"
# And a Start Menu of this run's own, for the same reason: setup now writes the
# shortcut, and pointing it at the real Start Menu would put a throwaway install
# in the person's menu and then take it out again.
$startMenuRoot = Join-Path $evidenceRoot 'start-menu'

# Reading a shortcut back, the way Windows reads it.
#
# Deliberately not shared with the writer in Invoke-NendoSetup.ps1 -- that script is
# bundled into the installer payload on its own and cannot depend on a second file,
# and an independent reader is the better test anyway: shared interop can be wrong
# in both directions at once and still agree with itself.
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NendoShortcutReader
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

    // Writes a shortcut pointing somewhere else, so the removal rule that retains one
    // it does not own has a case to be wrong about. Target only -- nothing here cares
    // what else the shortcut carries.
    public static void Repoint(string linkPath, string target)
    {
        IShellLinkW link = (IShellLinkW)new ShellLink();
        link.SetPath(target);
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
        PropertyKey key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
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

function Get-OwnerShortcutSnapshot {
    $link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nendo.lnk'
    if (-not (Test-Path -LiteralPath $link -PathType Leaf)) { return 'no owner shortcut' }
    return "$((Get-Item -LiteralPath $link).Length)/$((Get-FileHash -LiteralPath $link).Hash)"
}
$ownerShortcutBefore = Get-OwnerShortcutSnapshot

function Get-OwnerAssociationSnapshot {
    $extension = 'HKCU:\Software\Classes\.nendo'
    if (-not (Test-Path -LiteralPath $extension)) { return 'no owner association' }
    return [string](Get-ItemProperty -LiteralPath $extension -ErrorAction SilentlyContinue).'(default)'
}
$ownerAssociationBefore = Get-OwnerAssociationSnapshot
# The owner installation must be untouched throughout, judged by the files it
# owns: the paths and hashes in its inventory. A raw file count also counted the
# WebView2 profile a running owner instance keeps inside the folder, which churns
# its caches while the app is open and failed this guard on its own.
function Get-OwnedSnapshot {
    $inventory = Join-Path $ownerRoot 'nendo-install.json'
    if (-not (Test-Path -LiteralPath $inventory -PathType Leaf)) { return 'no owner installation' }
    $entries = @((Get-Content -LiteralPath $inventory -Raw | ConvertFrom-Json).files)
    return (@($entries | ForEach-Object {
        $file = Join-Path $ownerRoot $_.path
        "$($_.path)=$(if (Test-Path -LiteralPath $file -PathType Leaf) { (Get-FileHash -LiteralPath $file).Hash } else { 'missing' })"
    }) -join "`n")
}
$ownerBefore = Get-OwnedSnapshot

$script:setupRuns = 0
function Invoke-Setup([string] $Mode, [string[]] $Extra = @()) {
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $setup,
        '-Mode', $Mode, '-InstallRoot', $installRoot) + $Extra
    # Setup runs hidden, so its output is kept in the evidence folder and a failure
    # quotes the end of it: an exit code alone said nothing about what was refused.
    $script:setupRuns++
    $log = Join-Path $evidenceRoot ("setup-{0:D2}-{1}.log" -f $script:setupRuns, $Mode.ToLowerInvariant())
    $errors = "$log.errors"
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait `
        -RedirectStandardOutput $log -RedirectStandardError $errors
    if ($process.ExitCode -ne 0) {
        $tail = @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue | Select-Object -Last 8) +
            @(Get-Content -LiteralPath $errors -ErrorAction SilentlyContinue | Select-Object -Last 8)
        throw "Setup $Mode failed with exit code $($process.ExitCode). Log: $log`n$($tail -join "`n")"
    }
}

# Stage the payload the way the installer does: the published files plus the
# inventory that tells setup which of them it owns.
$staged = Join-Path $evidenceRoot 'staged-payload'
Copy-Item -LiteralPath $payload -Destination $staged -Recurse
Copy-Item -LiteralPath $inventorySource -Destination (Join-Path $staged 'nendo-install.json')
# The installer packs the setup script into its own payload and inventories it.
Copy-Item -LiteralPath $setup -Destination (Join-Path $staged 'Nendo.Setup.ps1')

# 1. First install, then verify every manifested byte landed.
Invoke-Setup 'Install' @('-PayloadRoot', $staged, '-ClassesRoot', $classesRoot, '-StartMenuRoot', $startMenuRoot)
foreach ($entry in $manifest.files) {
    if ([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Unsafe manifest path.' }
    $installed = Join-Path $installRoot $entry.path
    if (-not (Test-Path -LiteralPath $installed)) { throw "Missing installed file: $($entry.path)" }
    if ((Get-FileHash -LiteralPath $installed).Hash -ne $entry.sha256) { throw "Installed bytes differ: $($entry.path)" }
}

# 2. A file the installer does not own must survive an upgrade and an uninstall.
$userFile = Join-Path $installRoot 'owner-notes.nendo'
[IO.File]::WriteAllText($userFile, 'Unknown user bytes must survive setup.')
$userFileHash = (Get-FileHash -LiteralPath $userFile).Hash

# 3. An inventoried file that the next payload no longer owns must be removed.
$obsolete = Join-Path $installRoot 'obsolete-upgrade-fixture.txt'
[IO.File]::WriteAllText($obsolete, 'Old owned payload removed by the next version.')
$inventoryPath = Join-Path $installRoot 'nendo-install.json'
$inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
$inventory.files = @($inventory.files) + @(@{ path = 'obsolete-upgrade-fixture.txt'; sha256 = (Get-FileHash -LiteralPath $obsolete).Hash })
$inventory | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $inventoryPath

# 3b. Double-clicking a .nendo has to reach this install, with this icon. Every
# value is read back rather than assumed written: a registration that silently
# wrote nothing looks exactly like one that worked.
function Get-RegistryDefault([string] $Key) {
    if (-not (Test-Path -LiteralPath $Key)) { return $null }
    return [string](Get-ItemProperty -LiteralPath $Key -ErrorAction SilentlyContinue).'(default)'
}
# A named value that may not be there. Written out rather than read inline because
# under Set-StrictMode a missing value throws "The property 'X' cannot be found on
# this object" — which fails the lane, but with a sentence about PowerShell instead of
# a sentence about the registration that is missing. Falsification found both of them.
function Get-RegistryValue([string] $Key, [string] $Name) {
    if (-not (Test-Path -LiteralPath $Key)) { return $null }
    $property = Get-ItemProperty -LiteralPath $Key -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $property) { return $null }
    return [string]$property.$Name
}
$expectedCommand = '"' + (Join-Path $installRoot 'Nendo.Desktop.exe') + '" "%1"'
$expectedIcon = '"' + (Join-Path $installRoot 'Assets\DocumentIcon.ico') + '",0'
$association = [ordered]@{
    '.nendo'                                              = 'Nendo.Document'
    'Nendo.Document\shell\open\command'                   = $expectedCommand
    'Nendo.Document\DefaultIcon'                          = $expectedIcon
    'Applications\Nendo.Desktop.exe\shell\open\command'   = $expectedCommand
}
foreach ($relative in $association.Keys) {
    $actual = Get-RegistryDefault (Join-Path $classesRoot $relative)
    if ($actual -ne $association[$relative]) {
        throw "The file association is wrong at ${relative}: expected '$($association[$relative])', found '$actual'."
    }
}
$openWith = Join-Path $classesRoot '.nendo\OpenWithProgids'
if ($null -eq (Get-ItemProperty -LiteralPath $openWith -ErrorAction SilentlyContinue).'Nendo.Document') {
    throw 'Nendo is not offered in Open with: .nendo\OpenWithProgids carries no Nendo.Document value.'
}
# The icon the association points at has to be a file that is there, or Explorer
# draws the generic blank page and says nothing about why.
$iconPath = Join-Path $installRoot 'Assets\DocumentIcon.ico'
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) { throw "The document icon is not installed at $iconPath." }

# 3c. New > Nendo application. The command has to name this install and carry the
# switch, because Explorer creates nothing itself: without -new the launch opens a
# file that is not there instead of making one.
$expectedShellNew = '"' + (Join-Path $installRoot 'Nendo.Desktop.exe') + '" -new "%1"'
$shellNew = Get-RegistryValue (Join-Path $classesRoot '.nendo\ShellNew') 'Command'
if ($shellNew -ne $expectedShellNew) {
    throw "The New menu command is wrong: expected '$expectedShellNew', found '$shellNew'."
}

# 3d. What the notification centre calls Nendo. An unpackaged application has no
# manifest to say so, and without this a notification is attributed to whatever
# Windows made up from the executable path.
$identityKey = Join-Path $classesRoot 'AppUserModelId\Nendo.Desktop'
$identityName = Get-RegistryValue $identityKey 'DisplayName'
if ($identityName -ne 'Nendo') {
    throw "The application identity at $identityKey carries the display name '$identityName', not 'Nendo'."
}
$identityIcon = Get-RegistryValue $identityKey 'IconUri'
if (-not $identityIcon -or -not (Test-Path -LiteralPath $identityIcon -PathType Leaf)) {
    throw "The registered notification icon is not installed at '$identityIcon'."
}

# 3e. The Start Menu shortcut, and the property on it the taskbar reads. A shortcut
# whose identity does not match the one the process sets is worse than no shortcut:
# Windows then refuses to pin it and shows a second, menu-less taskbar button.
$shortcutPath = Join-Path $startMenuRoot 'Nendo.lnk'
if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw "Setup wrote no Start Menu shortcut at $shortcutPath." }
$shortcutTarget = [NendoShortcutReader]::Target($shortcutPath)
$expectedTarget = Join-Path $installRoot 'Nendo.Desktop.exe'
if ($shortcutTarget -ne $expectedTarget) {
    throw "The Start Menu shortcut points at '$shortcutTarget', not at '$expectedTarget'."
}
$shortcutIdentity = [NendoShortcutReader]::AppUserModelId($shortcutPath)
if ($shortcutIdentity -ne 'Nendo.Desktop') {
    throw "The Start Menu shortcut carries the application identity '$shortcutIdentity', not 'Nendo.Desktop'."
}

# 4. Reinstall in place: an upgrade over an existing installation.
Invoke-Setup 'Install' @('-PayloadRoot', $staged, '-ClassesRoot', $classesRoot, '-StartMenuRoot', $startMenuRoot)
if (Test-Path -LiteralPath $obsolete) { throw 'Upgrade retained an obsolete owned file.' }
if ((Get-FileHash -LiteralPath $userFile).Hash -ne $userFileHash) { throw 'Upgrade changed an unowned user file.' }
foreach ($entry in $manifest.files) {
    if ((Get-FileHash -LiteralPath (Join-Path $installRoot $entry.path)).Hash -ne $entry.sha256) { throw "Upgraded bytes differ: $($entry.path)" }
}

# 4b. Uninstall must keep what it does not own, and a registration can change hands.
# The New entry is repointed at something else first, so the removal has to notice
# that it no longer launches this install — the same rule the extension key follows,
# and a branch the happy path never reaches.
$foreignNewCommand = '"C:\Program Files\Another\Editor.exe" -new "%1"'
[void](New-ItemProperty -LiteralPath (Join-Path $classesRoot '.nendo\ShellNew') -Name 'Command' `
    -Value $foreignNewCommand -PropertyType String -Force)

# 4c. And the identity key does not stay ours after the application has run: Windows
# adds a CustomActivator to it the first time notifications register, naming a CLSID
# elsewhere in the class store. Nothing in this lane starts Nendo, so that value is
# planted here — otherwise the branch that removes the activator is never reached and
# a guard over it would be guarding nothing. Falsification found exactly that.
# 4d. A shortcut at a name we do not use must survive, so the removal is by name and
# target rather than a sweep of the folder.
$foreignShortcut = Join-Path $startMenuRoot 'Another editor.lnk'
Copy-Item -LiteralPath $shortcutPath -Destination $foreignShortcut -Force

$plantedActivator = '{00000000-1111-2222-3333-444444444444}'
$plantedActivatorKey = Join-Path $classesRoot "CLSID\$plantedActivator"
[void](New-ItemProperty -LiteralPath (Join-Path $classesRoot 'AppUserModelId\Nendo.Desktop') `
    -Name 'CustomActivator' -Value $plantedActivator -PropertyType String -Force)
[void](New-Item -Path (Join-Path $plantedActivatorKey 'LocalServer32') -Force)

# 5. Uninstall removes what it owns and keeps what it does not.
Invoke-Setup 'Uninstall' @('-ClassesRoot', $classesRoot, '-StartMenuRoot', $startMenuRoot)
foreach ($entry in $manifest.files) {
    if (Test-Path -LiteralPath (Join-Path $installRoot $entry.path)) { throw "Uninstall left an owned file: $($entry.path)" }
}
if (Test-Path -LiteralPath (Join-Path $installRoot 'Nendo.Setup.ps1')) { throw 'Uninstall left the bundled setup script.' }
if (-not (Test-Path -LiteralPath $userFile)) { throw 'Uninstall removed an unowned user file.' }
if ((Get-FileHash -LiteralPath $userFile).Hash -ne $userFileHash) { throw 'Uninstall changed an unowned user file.' }
if (Test-Path -LiteralPath "$installRoot.previous") { throw 'Uninstall left its rollback payload.' }

# 5b. And it takes the association with it, so a .nendo file does not keep
# pointing at an executable that has been removed.
foreach ($relative in @('Nendo.Document', 'Applications\Nendo.Desktop.exe')) {
    if (Test-Path -LiteralPath (Join-Path $classesRoot $relative)) { throw "Uninstall left the $relative registration." }
}
if ((Get-RegistryDefault (Join-Path $classesRoot '.nendo')) -eq 'Nendo.Document') {
    throw 'Uninstall left .nendo pointing at Nendo.Document.'
}
if (Test-Path -LiteralPath (Join-Path $classesRoot 'AppUserModelId\Nendo.Desktop')) {
    throw 'Uninstall left the application identity registration.'
}
# The activator with it. Left behind, it points at an executable that has just been
# removed, and the next install mints another one: an orphan per reinstall cycle.
if (Test-Path -LiteralPath $plantedActivatorKey) {
    throw "Uninstall left the notification activator behind at $plantedActivatorKey."
}
if (Test-Path -LiteralPath $shortcutPath) { throw 'Uninstall left the Start Menu shortcut.' }
if (-not (Test-Path -LiteralPath $foreignShortcut)) {
    throw 'Uninstall removed a Start Menu shortcut it did not write.'
}
# And the New entry that had changed hands is still there, still pointing where its
# new owner put it.
$survivingNew = Get-RegistryValue (Join-Path $classesRoot '.nendo\ShellNew') 'Command'
if ($survivingNew -ne $foreignNewCommand) {
    throw "Uninstall took a New menu entry that belongs to somebody else: expected '$foreignNewCommand', found '$survivingNew'."
}

# 5c. And the other half of the same rule, which needs its own cycle because a run
# can only prove one outcome for one shortcut. Install again, point Nendo.lnk at
# something else, and uninstall: a shortcut that no longer launches this install
# belongs to whoever repointed it, exactly as the extension key and the New entry do.
Invoke-Setup 'Install' @('-PayloadRoot', $staged, '-ClassesRoot', $classesRoot, '-StartMenuRoot', $startMenuRoot)
$strangerTarget = Join-Path $installRoot 'Uninstall.exe'
if (-not (Test-Path -LiteralPath $strangerTarget -PathType Leaf)) { $strangerTarget = Join-Path $installRoot 'Nendo.Setup.ps1' }
[NendoShortcutReader]::Repoint($shortcutPath, $strangerTarget)
Invoke-Setup 'Uninstall' @('-ClassesRoot', $classesRoot, '-StartMenuRoot', $startMenuRoot)
if (-not (Test-Path -LiteralPath $shortcutPath)) {
    throw 'Uninstall removed a Start Menu shortcut that points somewhere else.'
}
Remove-Item -LiteralPath $shortcutPath -Force

# 6. The owner installation must be untouched throughout.
$ownerAfter = Get-OwnedSnapshot
if ($ownerAfter -ne $ownerBefore) { throw "The owner installation's owned files changed during the isolated run." }
# Including what this account opens .nendo with, which is what a careless version
# of this lane would have taken over and then deleted.
if ((Get-OwnerAssociationSnapshot) -ne $ownerAssociationBefore) {
    throw 'The isolated run changed the real .nendo association for this user.'
}
# And the person's real Start Menu, now that setup writes one.
if ((Get-OwnerShortcutSnapshot) -ne $ownerShortcutBefore) {
    throw "The isolated run changed the real Start Menu shortcut for this user."
}
# And the run's own class store goes with it.
$runClassesRoot = Split-Path -Parent $classesRoot
if (Test-Path -LiteralPath $runClassesRoot) { Remove-Item -LiteralPath $runClassesRoot -Recurse -Force }

# 7. The staged payload is a copy of an already hash-verified payload, not
# evidence, and costs ~308 MB per run. Prune it now that the run has passed, so
# what this directory retains is the report and the fixtures. Every failure above
# throws before reaching here, which leaves the payload in place for diagnosis.
$stagedRetained = $true
$reclaimedBytes = [long]0
if (-not $KeepStagedPayload) {
    try {
        $reclaimedBytes = [long](Get-ChildItem -LiteralPath $staged -Recurse -File | Measure-Object Length -Sum).Sum
        Remove-Item -LiteralPath $staged -Recurse -Force
        $stagedRetained = $false
    }
    catch {
        # A pass is not invalidated by a failed cleanup; report it and continue.
        $reclaimedBytes = [long]0
        Write-Warning "Could not prune the staged payload at ${staged}: $($_.Exception.Message)"
    }
}

$result = [ordered]@{
    result = 'passed'
    buildId = (Get-Content -LiteralPath $inventorySource -Raw | ConvertFrom-Json).buildId
    installedFiles = @($manifest.files).Count
    installRoot = $installRoot
    ownerInstallationUntouched = $true
    ownerFileCount = $ownerAfter
    stagedPayloadRetained = $stagedRetained
    verified = @('first install byte-for-byte', 'in-place upgrade', 'obsolete owned file removed',
        'unowned user file preserved across upgrade and uninstall', 'uninstall removes owned files', 'no rollback payload left',
        '.nendo association written, pointing at this install and at an installed icon',
        'New > Nendo application registered with the -new command',
        'the application identity registered with its display name and an installed icon',
        'the Start Menu shortcut written, pointing at this install and carrying that identity',
        'association, New entry, identity and shortcut all removed on uninstall',
        'a New entry that has changed hands is left where its new owner put it',
        'a Start Menu shortcut that has changed hands, and one at another name, are both left alone',
        'the notification activator the identity key names is removed with it',
        'the real per-user .nendo association and Start Menu shortcut untouched')
    notCovered = @('NSIS bootstrapper and payload extraction', 'HKCU uninstall registration',
        'anything the shell itself does with these registrations: drawing the icon or the taskbar overlay, launching Nendo from a real double-click, populating the Jump List, or creating a file from the New menu',
        'clean Windows user', 'offline or disconnected machine', 'human usability')
    os = [Environment]::OSVersion.VersionString
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'setup-isolated.json')
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
Update-InstallerLane -StatusPath (Join-Path $repoRoot 'artifacts/installer/installer-status.json') `
    -Lane 'setupLogic' -BuildId $result.buildId -Status 'passed' -Evidence (Join-Path $evidenceRoot 'setup-isolated.json')
Write-Output "Isolated setup smoke passed: $evidenceRoot"
if (-not $stagedRetained) {
    Write-Output ("Pruned the staged payload: {0:N0} MB reclaimed." -f ($reclaimedBytes / 1MB))
}
