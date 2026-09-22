# Drives a real Nendo window to check what closing it now does.
#
# What this lane covers: the close button hides the window and leaves the process
# and its open file alive, the window comes back, and an owner pin still exits.
#
# What it does NOT and cannot cover: the notification-area icon itself, its menu,
# and the Windows notifications. Nothing scriptable enumerates another process's
# tray icon, and a notification is shown by the shell, not by this application.
# Those stay owner-reported — see docs/roadmap.md. Do not read a pass here as a
# statement about them.
[CmdletBinding()]
param(
    [string] $Executable
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Executable) { $Executable = Join-Path $repoRoot 'artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe' }
if (-not (Test-Path -LiteralPath $Executable)) { throw "Nendo.Desktop.exe was not found at $Executable. Build it first." }
$evidenceRoot = Join-Path $repoRoot ('artifacts/evidence/runs/review-shell-' + [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $evidenceRoot)

Add-Type -Namespace NendoShellLane -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@

# Reading a window's shell identity, which is what the taskbar groups on.
#
# There is no way to ask another process what identity it set on itself. The shell
# keeps it on the window instead, and this reads it from there -- so what is measured
# is the thing that matters rather than the call that was made.
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NendoWindowIdentity
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

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    [DllImport("shell32.dll", PreserveSig = false)]
    private static extern void SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object ppv);

    [DllImport("propsys.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void PropVariantToStringAlloc(ref PropVariant pv, out IntPtr value);

    [DllImport("ole32.dll", PreserveSig = false)]
    private static extern void PropVariantClear(ref PropVariant pv);

    public static string Of(IntPtr hwnd)
    {
        Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
        object instance;
        SHGetPropertyStoreForWindow(hwnd, ref iid, out instance);
        IPropertyStore store = (IPropertyStore)instance;
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

# A shell identity of this run's own. Windows stores a custom Jump List in a file
# named after a hash of the identity, so without this the lane would be writing
# entries into the person's real taskbar menu and then asserting against them.
$laneAppId = 'Nendo.ShellLane.' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
# An identity of its own is not free. Windows registers an unpackaged application's
# notification identity in the real per-user class store -- the identity key and a
# CLSID for its activator -- and the App SDK's Unregister revokes the running class
# object without removing either. A lane that mints a new identity every run and
# walks away leaves one pair behind every time, on the machine that ran it. This
# lane asserts both keys and then deletes both.
$laneIdentityKey = "HKCU:\Software\Classes\AppUserModelId\$laneAppId"
$customDestinations = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Recent\CustomDestinations'
function Get-CustomDestinationNames {
    if (-not (Test-Path -LiteralPath $customDestinations)) { return @() }
    return @(Get-ChildItem -LiteralPath $customDestinations -File -Filter '*.customDestinations-ms' |
        ForEach-Object { $_.Name })
}
$destinationsBefore = Get-CustomDestinationNames

function Wait-For {
    param([scriptblock] $Condition, [int] $TimeoutMs = 30000, [string] $What = 'condition')
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.ElapsedMilliseconds -lt $TimeoutMs) {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out after $TimeoutMs ms waiting for $What. Evidence root: $evidenceRoot"
}

function Get-MainWindow {
    param([Diagnostics.Process] $Target)
    $Target.Refresh()
    return $Target.MainWindowHandle
}

$results = [ordered]@{}

function Start-Nendo {
    param([string] $CloseAction, [string] $FileName, [switch] $Reopen)
    $environment = @{
        NENDO_STARTUP_CREATE = $(if (-not $Reopen) { Join-Path $evidenceRoot $FileName } else { '' })
        NENDO_STARTUP_OPEN = $(if ($Reopen) { Join-Path $evidenceRoot $FileName } else { '' })
        NENDO_DEVICE_STATE_ROOT = (Join-Path $evidenceRoot 'device-state')
        WEBVIEW2_USER_DATA_FOLDER = (Join-Path $evidenceRoot 'webview-profile')
        NENDO_DESKTOP_APP_ID = $laneAppId
    }
    if ($CloseAction) { $environment['NENDO_DESKTOP_CLOSE_ACTION'] = $CloseAction }
    $process = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path $Executable) -PassThru -Environment $environment
    Wait-For { (Get-MainWindow $process) -ne [IntPtr]::Zero } -What 'the main window to appear' | Out-Null
    Wait-For { [NendoShellLane.Win]::IsWindowVisible((Get-MainWindow $process)) } -What 'the main window to become visible' | Out-Null
    return $process
}

# --- The default: closing hides, and the process keeps the file open ---------
$target = $null
try {
    $target = Start-Nendo -CloseAction 'tray' -FileName 'shell-lane.nendo'
    $handle = Get-MainWindow $target
    [void] $target.CloseMainWindow()
    Wait-For { -not [NendoShellLane.Win]::IsWindowVisible($handle) } -What 'the window to hide' | Out-Null
    Start-Sleep -Milliseconds 1500
    $target.Refresh()
    if ($target.HasExited) { throw 'Closing the window ended the process; it should have stayed in the notification area.' }
    $results['hidesOnClose'] = $true
    $results['staysResident'] = $true

    # A hidden window still holds its file, which is the whole point of the change.
    if (-not (Test-Path -LiteralPath (Join-Path $evidenceRoot 'shell-lane.nendo'))) {
        throw 'The file the hidden process is holding open does not exist.'
    }
    $results['fileStillOpen'] = $true
}
finally {
    if ($null -ne $target -and -not $target.HasExited) {
        # No tray menu is reachable from here, so end the resident process the only
        # other way there is. This is teardown, not the exit path under test.
        $target.Kill()
        [void] $target.WaitForExit(15000)
    }
}

# --- The shell identity, and the taskbar menu filed under it ------------------
# Both are about the same thing: whether Windows and Nendo agree on who Nendo is.
# The window's identity is what the taskbar groups on; the Jump List file appearing
# under a hash of that identity is the shell having accepted a menu for it.
$target = $null
$laneDestination = $null
try {
    $target = Start-Nendo -CloseAction 'exit' -FileName 'shell-lane.nendo' -Reopen
    $handle = Get-MainWindow $target

    Wait-For { $script:identity = [NendoWindowIdentity]::Of($handle); $null -ne $script:identity } `
        -What 'the window to carry a shell identity' | Out-Null
    if ($script:identity -ne $laneAppId) {
        throw "The taskbar would group this window under '$($script:identity)', not under the '$laneAppId' the process was told to use."
    }
    $results['windowCarriesTheShellIdentity'] = $laneAppId

    # The Jump List, measured as the shell storing one: a file that was not there
    # before, under this run's own identity, carrying the path of the open file.
    $openFile = Join-Path $evidenceRoot 'shell-lane.nendo'
    # A shortcut stores its argument as UTF-16, so the path is in the file verbatim.
    # Latin1 maps every byte to one character and back, which makes a byte search a
    # plain string search without decoding anything as text it is not.
    $needle = [Text.Encoding]::Latin1.GetString([Text.Encoding]::Unicode.GetBytes($openFile))
    Wait-For {
        foreach ($name in (Get-CustomDestinationNames | Where-Object { $destinationsBefore -notcontains $_ })) {
            $candidate = Join-Path $customDestinations $name
            try { $bytes = [IO.File]::ReadAllBytes($candidate) } catch { continue }
            if ([Text.Encoding]::Latin1.GetString($bytes).Contains($needle)) {
                $script:laneDestination = $candidate
                return $true
            }
        }
        return $false
    } -What 'Windows to store a Jump List naming the open file' | Out-Null
    $results['jumpListStoredByWindows'] = Split-Path -Leaf $script:laneDestination

    # And the process identity itself, which is a different call from the one on the
    # window and until now was measured by nothing. Windows files an unpackaged
    # application's notification registration under whatever identity the process has
    # when it registers, so this key existing under the lane's own name is the only
    # observable proof that SetCurrentProcessExplicitAppUserModelID ran, and ran
    # before the notifier did.
    Wait-For { Test-Path -LiteralPath $laneIdentityKey } `
        -What 'Windows to register this run''s notification identity under the name the process was given' | Out-Null
    $activator = (Get-ItemProperty -LiteralPath $laneIdentityKey -ErrorAction SilentlyContinue).CustomActivator
    if (-not $activator) {
        throw "Windows registered $laneAppId with no activator; the notification identity is not usable. Evidence root: $evidenceRoot"
    }
    $results['processIdentityRegistered'] = $activator

    if (-not $target.CloseMainWindow()) { throw 'The window refused the close request.' }
    if (-not $target.WaitForExit(30000)) { throw 'Exit-on-close did not end the process.' }
    $results['exitPinEndsTheProcess'] = $true
}
finally {
    if ($null -ne $target -and -not $target.HasExited) { $target.Kill(); [void] $target.WaitForExit(15000) }
    # The lane's own taskbar menu goes with the lane. It names an evidence file that
    # is about to be deleted, and it belongs to an identity nothing will run again.
    if ($null -ne $script:laneDestination -and (Test-Path -LiteralPath $script:laneDestination)) {
        Remove-Item -LiteralPath $script:laneDestination -Force -ErrorAction SilentlyContinue
    }
    # And the registrations Windows made for it. In the finally block rather than
    # after the assertions, so a failed run leaves nothing behind either.
    if (Test-Path -LiteralPath $laneIdentityKey) {
        $leftover = (Get-ItemProperty -LiteralPath $laneIdentityKey -ErrorAction SilentlyContinue).CustomActivator
        if ($leftover) {
            $clsid = "HKCU:\Software\Classes\CLSID\$leftover"
            if (Test-Path -LiteralPath $clsid) { Remove-Item -LiteralPath $clsid -Recurse -Force -ErrorAction SilentlyContinue }
        }
        Remove-Item -LiteralPath $laneIdentityKey -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# The cleanup is itself measured, because nothing else would notice it stopping. A
# lane that leaves a registration behind fails no assertion and grows the class store
# by one pair a run; this one says so on the run that breaks it.
foreach ($leak in @($laneIdentityKey, $(if ($results.Contains('processIdentityRegistered')) { "HKCU:\Software\Classes\CLSID\$($results['processIdentityRegistered'])" } else { $null }))) {
    if ($leak -and (Test-Path -LiteralPath $leak)) {
        throw "The lane left a registration behind in the real class store: $leak"
    }
}

$results['notCovered'] = @(
    'The notification-area icon and its menu: nothing scriptable enumerates another process''s tray icon.',
    'Windows notifications: raised by the shell, not observable from here.',
    'The one-time notification-area explanation.',
    'The taskbar drawing the Jump List, or an overlay badge on the button: both are the shell''s own painting.'
)
# Read back rather than claimed. The removes above are best effort, and a record
# that says "none" because the line above it ran is not a measurement of anything.
$results['leftBehind'] = @(@(
    $laneIdentityKey,
    $(if ($results.Contains('processIdentityRegistered')) { "HKCU:\Software\Classes\CLSID\$($results['processIdentityRegistered'])" } else { $null }),
    $script:laneDestination
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($results['leftBehind'].Count -eq 0) { $results['leftBehind'] = @('none') }
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'results.json')
Write-Host 'OK       the close button hides the window and leaves the file open; the exit pin still exits.'
Write-Host "OK       the window carries the shell identity it was given, and Windows stored a Jump List naming the open file."
Write-Host "         Evidence: $evidenceRoot"
Write-Host '         Not covered here: the tray icon, its menu, the notifications, and the taskbar drawing either the'
Write-Host '         Jump List or an overlay badge. Those are owner-reported.'
