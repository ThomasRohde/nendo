[CmdletBinding()]
param(
    [Parameter(Mandatory)][int] $TargetProcessId,
    [Parameter(Mandatory)][ValidateSet('Inspect','Crash')][string] $Action,
    [string] $Executable = $env:NENDO_RUNTIME_EXPECTED_EXECUTABLE
)
# The native half of the record-panel journey (ADR-0013, 2026-09-24; W-061). The page can
# say where its placeholder is; only Windows can say where the contained view actually is,
# whether it is shown, how much of it is cut away, and how many views are running. This
# measures those, in physical pixels, and prints them as base64 JSON for the journey.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$target = Get-Process -Id $TargetProcessId
if (-not $Executable -or $target.Path -ne (Resolve-Path -LiteralPath $Executable).Path) { throw 'The target is not the owned Nendo executable.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ExtensionPanelProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    public delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public static List<IntPtr> Children(IntPtr parent) {
        var found = new List<IntPtr>();
        EnumChildWindows(parent, (window, _) => { found.Add(window); return true; }, IntPtr.Zero);
        return found;
    }
}
'@
# Physical pixels throughout, whatever the display scale.
[void][ExtensionPanelProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$helpers = @(Get-CimInstance Win32_Process -Filter "Name = 'Nendo.ExtensionHost.exe' AND ParentProcessId = $TargetProcessId")
if ($Action -eq 'Crash') {
    if ($helpers.Count -ne 1) { throw "Expected one running view to stop, found $($helpers.Count)." }
    Stop-Process -Id $helpers[0].ProcessId -Force
    return
}
$main = $target.MainWindowHandle
$origin = New-Object ExtensionPanelProbe+Point
[void][ExtensionPanelProbe]::ClientToScreen($main, [ref]$origin)
$helperIds = @($helpers | ForEach-Object { [uint32]$_.ProcessId })
$windows = foreach ($child in [ExtensionPanelProbe]::Children($main)) {
    [uint32]$owner = 0
    [void][ExtensionPanelProbe]::GetWindowThreadProcessId($child, [ref]$owner)
    # Only the contained view's own top window, reparented under Nendo's.
    if ($helperIds -notcontains $owner -or [ExtensionPanelProbe]::GetParent($child) -ne $main) { continue }
    $rect = New-Object ExtensionPanelProbe+Rect
    [void][ExtensionPanelProbe]::GetWindowRect($child, [ref]$rect)
    $box = New-Object ExtensionPanelProbe+Rect
    $kind = [ExtensionPanelProbe]::GetWindowRgnBox($child, [ref]$box)
    [ordered]@{
        ProcessId = $owner
        Visible = [ExtensionPanelProbe]::IsWindowVisible($child)
        # Relative to the main window's client area, which is where the host places it.
        Left = $rect.Left - $origin.X; Top = $rect.Top - $origin.Y
        Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top
        # 0 no region, 1 empty, 2 one rectangle; the box is in the view's own coordinates.
        RegionKind = $kind
        Region = [ordered]@{ Left = $box.Left; Top = $box.Top; Width = $box.Right - $box.Left; Height = $box.Bottom - $box.Top }
    }
}
$report = [ordered]@{
    Dpi = [ExtensionPanelProbe]::GetDpiForWindow($main)
    Helpers = $helperIds
    Windows = @($windows)
}
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 5 -Compress)))
