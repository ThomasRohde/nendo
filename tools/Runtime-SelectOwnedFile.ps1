# Uses Windows PowerShell's .NET Framework native-control UIA providers.
# No desktop input is sent. Native commit split-buttons use an exact HWND.
#
# The `p4-`/`p5-`/`review-outcomes-` prefixes below are a safety allow-list, not
# milestone naming: this script drives a real native file picker, so it refuses
# any fixture root outside artifacts/ or not named by a harness. The runtime
# lanes' evidence directory names are therefore load-bearing — renaming them for
# tidiness breaks this guard. Change both together, or neither.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][int] $ProcessId,
    [Parameter(Mandatory)][string] $FixtureRoot,
    [Parameter(Mandatory)][string] $SelectedPath,
    [switch] $Directory,
    [switch] $SaveNew,
    [ValidateSet('Review package', 'Export package')][string] $CommitButtonText,
    [switch] $InspectOnly,
    [switch] $Cancel,
    [string] $Executable = $env:NENDO_RUNTIME_EXPECTED_EXECUTABLE
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ownedRoot = [IO.Path]::GetFullPath($FixtureRoot)
$path = [IO.Path]::GetFullPath($SelectedPath)
$artifactsPrefix = (Join-Path $repoRoot 'artifacts') + [IO.Path]::DirectorySeparatorChar
if (-not $ownedRoot.StartsWith($artifactsPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not ((Split-Path $ownedRoot -Leaf).StartsWith('p4-', [StringComparison]::Ordinal) -or
        (Split-Path $ownedRoot -Leaf).StartsWith('p5-', [StringComparison]::Ordinal) -or
        (Split-Path $ownedRoot -Leaf).StartsWith('review-outcomes-', [StringComparison]::Ordinal) -or
        (Split-Path $ownedRoot -Leaf) -match '^extension-journey-[a-f0-9]{32}$') -or
    -not $path.StartsWith($ownedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    ($SaveNew -and ($Directory -or (Test-Path -LiteralPath $path) -or -not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($path)) -PathType Container))) -or
    (-not $SaveNew -and -not (Test-Path -LiteralPath $path -PathType $(if ($Directory) { 'Container' } else { 'Leaf' })))) { throw 'Selection must be an owned fixture, or a new destination with an existing owned parent.' }
$firstPart = if ($SaveNew) { [IO.Path]::GetDirectoryName($path) } else { $path }
for ($part = $firstPart; $part.Length -ge $ownedRoot.Length; $part = [IO.Path]::GetDirectoryName($part)) {
    if ((Get-Item -LiteralPath $part).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a redirected fixture selection.' }
    if ($part -eq $ownedRoot) { break }
}
$expectedExe = if ($Executable) { (Resolve-Path -LiteralPath $Executable).Path } else { Join-Path $repoRoot 'artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe' }
$target = Get-Process -Id $ProcessId
if ($target.Path -ne $expectedExe -or $target.MainWindowHandle -eq 0) { throw 'Unexpected Desktop process.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName UIAutomationClientsideProviders
[void][System.Windows.Automation.AutomationElement]::RootElement
# Initialize UIA before registering the table: registering first throws inside
# the managed proxy manager. Bind to the owned app only after registration.
[System.Windows.Automation.ClientSettings]::RegisterClientSideProviders(
    [UIAutomationClientsideProviders.UIAutomationClientSideProviders]::ClientSideProviderDescriptionTable)
$root = [System.Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
$editCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$idCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $(if ($Directory) { '1152' } else { '1148' }))
if (-not $Directory) {
    $modernId = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'FileNameControlHost')
    $idCondition = New-Object System.Windows.Automation.OrCondition($idCondition, $modernId)
}
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
$container = $null
while ($null -eq $container -and [DateTimeOffset]::UtcNow -lt $deadline) {
    $container = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCondition)
    if ($null -eq $container) {
        # Windows App SDK pickers may be separate owned top-level windows.
        $ownedPid = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
        $ownedWindows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $ownedPid)
        foreach ($candidate in $ownedWindows) {
            $match = $candidate.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCondition)
            if ($null -ne $match) { $root = $candidate; $container = $match; break }
        }
    }
    if ($null -eq $container) { Start-Sleep -Milliseconds 100 }
}
if ($null -eq $container) {
    $diagnostic = @($ownedWindows | ForEach-Object {
        $window = $_
        $controls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        @{ Window = $window.Current.Name; Class = $window.Current.ClassName; Controls = @($controls |
            Where-Object { $_.Current.ControlType -in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::ComboBox) } |
            ForEach-Object { @{ Id = $_.Current.AutomationId; Class = $_.Current.ClassName; Type = $_.Current.ControlType.ProgrammaticName } }) }
    }) | ConvertTo-Json -Depth 5 -Compress
    # See it, rather than infer: capture the main window and list every top-level window.
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class Cap{[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);}'
    $shot = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/extension-runtime-results'))) 'picker-missing.png'
    $mainRect = $root.Current.BoundingRectangle
    if ($mainRect.Width -ge 1 -and $mainRect.Height -ge 1) {
        $bmp = New-Object Drawing.Bitmap([int]$mainRect.Width, [int]$mainRect.Height); $g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
        try { [void][Cap]::PrintWindow([IntPtr]$root.Current.NativeWindowHandle, $dc, 2) } finally { $g.ReleaseHdc($dc); $g.Dispose() }
        $bmp.Save($shot, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    }
    $tops = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
        $pn = try { (Get-Process -Id $_.Current.ProcessId -ErrorAction Stop).ProcessName } catch { '?' }
        "$($_.Current.ClassName)|pid=$($_.Current.ProcessId)($pn)|'$($_.Current.Name)'" })
    throw "Owned filename container was not found. Capture: $shot. Owned window controls: $diagnostic. Top-level: [$($tops -join ' ; ')]"
}
$edit = if ($container.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) { $container }
    else { $container.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition) }
if ($null -eq $edit -or $edit.Current.ProcessId -ne $ProcessId) {
    throw 'Owned filename edit was not found.'
}
$value = [System.Windows.Automation.ValuePattern]$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
if ($InspectOnly) { Write-Output 'Owned native filename ValuePattern is available.'; exit 0 }
if (-not $Cancel) {
    $edit.SetFocus()
    $value.SetValue($path)
    if ($value.Current.Value -ne $path) { throw 'Owned filename edit did not retain the requested value.' }
}
$buttonId = if ($Cancel) { '2' } else { '1' }
$buttonIdCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $buttonId)
$buttonClassCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Button')
$buttonCondition = New-Object System.Windows.Automation.AndCondition($buttonIdCondition, $buttonClassCondition)
$button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
if ($null -eq $button -and $CommitButtonText -and -not $Cancel) {
    $buttonName = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $CommitButtonText)
    $buttonType = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.AndCondition($buttonName, $buttonType)))
}
if ($null -eq $button -or $button.Current.ProcessId -ne $ProcessId -or
    -not $button.Current.IsEnabled) {
    throw 'Owned file picker confirmation was not found.'
}
if ($button.Current.NativeWindowHandle -eq 0 -or $button.Current.ClassName -ne 'Button') {
    ([System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
    Write-Output 'Owned modern picker invoked; no desktop input sent.'
    exit 0
}
# The managed provider's Invoke can fail while registering a hot key. Use only
# the exact revalidated native picker button instead; no global input or retry
# of an ambiguously completed UIA invocation is needed.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class P4PickerCommit {
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr w);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr w, StringBuilder name, int size);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr w, uint m, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
    public static void Click(IntPtr w, int pid, int controlId) {
        uint owner; GetWindowThreadProcessId(w, out owner);
        var name=new StringBuilder(128); GetClassName(w,name,name.Capacity);
        if(owner!=pid || name.ToString()!="Button" || GetDlgCtrlID(w)!=controlId || (controlId!=1 && controlId!=2)) throw new InvalidOperationException("Unverified picker button.");
        IntPtr result;
        if(SendMessageTimeout(w,0x00f5,IntPtr.Zero,IntPtr.Zero,2,2000,out result)==IntPtr.Zero) throw new InvalidOperationException("Owned picker click timed out.");
    }
}
'@
[P4PickerCommit]::Click([IntPtr]$button.Current.NativeWindowHandle, $ProcessId, [int]$buttonId)
Write-Output 'Owned filename and picker-button actions completed; no desktop input sent.'
