[CmdletBinding()]
param(
    [Parameter(Mandatory)][int] $TargetProcessId,
    [Parameter(Mandatory)][ValidateSet('Inspect','MinimumSize','Compact','Wide','Maximize','Select node','Open record','Focus graph','Studio','Close','Return focus','Crash renderer','Disable view','Resize pane','Drag pane')][string] $Action,
    [string] $Executable = $env:NENDO_RUNTIME_EXPECTED_EXECUTABLE,
    [string] $Capture,
    [string] $OwnedRunRoot,
    # Arrow presses on the boundary: positive widens the pane, negative narrows it.
    [int] $ResizeSteps = 0,
    # Physical pixels to drag the boundary by, as a pointer: positive moves it right, which
    # narrows the pane. A different code path from the arrow keys, and the one a person uses.
    [int] $DragBy = 0
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$target = Get-Process -Id $TargetProcessId
if (-not $Executable -or $target.Path -ne (Resolve-Path -LiteralPath $Executable).Path) { throw 'The target is not the owned Nendo executable.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExtensionFocusProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct ThreadInfo {
        public uint Size, Flags; public IntPtr Active, Focus, Capture, Menu, MoveSize, Caret; public Rect CaretRect;
    }
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref ThreadInfo info);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int cmd);
    // Accessibility rectangles are physical pixels; the pane's own widths are DIPs. Without
    // this the two cannot be compared on a scaled display, which is most of them.
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    // A real pointer on the boundary. The arrow keys and the drag are different code inside
    // the application, so driving one says nothing about the other.
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    // Accessibility rectangles are true screen pixels. A thread that is not per-monitor aware
    // has its cursor calls scaled for it, so on a 150% display every press lands half a window
    // to the right of where it was aimed -- which looks exactly like a control ignoring input.
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int dx, dy; public uint mouseData, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public MouseInput mouse; }
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool join);
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    // What is actually on top of the boundary. A child window over the strip takes the press
    // before any XAML element sees it, and no layout measurement would show that.
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, System.Text.StringBuilder name, int count);
    public static string ClassAt(int x, int y) {
        Point p = new Point(); p.X = x; p.Y = y;
        IntPtr w = WindowFromPoint(p);
        if (w == IntPtr.Zero) { return "none"; }
        var name = new System.Text.StringBuilder(256);
        GetClassName(w, name, name.Capacity);
        uint owner; GetWindowThreadProcessId(w, out owner);
        return name.ToString() + "/" + owner;
    }
}
'@
$true_ = [System.Windows.Automation.Condition]::TrueCondition
$descendants = [System.Windows.Automation.TreeScope]::Descendants
$pidCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetProcessId)
# The custom view is a pane inside the main window, not a window of its own, and that window also
# holds the Workbench webview, whose accessibility subtree is large enough that a descendant search
# from the window root never reaches elements behind it. Walk the XAML tree ourselves and never
# descend into the webview: the pane is addressed through its own controls.
function Get-HostElements([System.Windows.Automation.AutomationElement] $window) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $found = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
    $queue = [System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new()
    $queue.Enqueue($window)
    while ($queue.Count) {
        $node = $queue.Dequeue()
        $child = $walker.GetFirstChild($node)
        while ($null -ne $child) {
            if ($child.Current.ProcessId -eq $TargetProcessId) {
                $found.Add($child)
                if ($child.Current.AutomationId -ne 'workbench.webview') { $queue.Enqueue($child) }
            }
            $child = $walker.GetNextSibling($child)
        }
    }
    return $found
}
$root = $null; $open = $null; $hostElements = @()
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
while ($null -eq $open -and [DateTimeOffset]::UtcNow -lt $deadline) {
    foreach ($window in @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCondition))) {
        $elementsHere = @(Get-HostElements $window)
        $candidate = @($elementsHere | Where-Object { $_.Current.AutomationId -eq 'extensions.openRecord' }) | Select-Object -First 1
        if ($null -ne $candidate) { $root = $window; $open = $candidate; $hostElements = $elementsHere; break }
    }
    if ($null -eq $open) { Start-Sleep -Milliseconds 100 }
}
if ($null -eq $open) {
    # Say what was visible, so a missing pane is diagnosable, and save a capture so it can be seen.
    $seen = foreach ($window in @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCondition))) {
        $children = @($window.FindAll([System.Windows.Automation.TreeScope]::Children, $true_) | ForEach-Object {
            $p = if ($_.Current.ProcessId -ne $TargetProcessId) { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName } else { 'self' }
            $b = $_.Current.BoundingRectangle
            "$($_.Current.ClassName)/$($_.Current.AutomationId)/$p/rect=$([int]$b.Left),$([int]$b.Top),$([int]$b.Width)x$([int]$b.Height)" })
        $ids = @(Get-HostElements $window | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')|$($_.Current.AutomationId)|$($_.Current.Name)" })
        "window '$($window.Current.Name)' children=[$($children -join '; ')] xaml=[$($ids -join ' ; ')]"
    }
    $shot = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/extension-runtime-results'))) 'pane-missing.png'
    foreach ($window in @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCondition))) {
        Add-Type -AssemblyName System.Drawing
        $wb = $window.Current.BoundingRectangle
        if ($wb.Width -lt 1 -or $wb.Height -lt 1) { continue }
        $bitmap = [Drawing.Bitmap]::new([int]$wb.Width, [int]$wb.Height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap); $dc = $graphics.GetHdc()
        try { [void][ExtensionFocusProbe]::PrintWindow([IntPtr]$window.Current.NativeWindowHandle, $dc, 2) } finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
        $bitmap.Save($shot, [Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose(); break
    }
    throw "The owned custom-view pane did not open in the main window. Capture: $shot. Seen: $($seen -join ' | ')"
}
if ($Action -eq 'Maximize') {
    [void][ExtensionFocusProbe]::ShowWindow([IntPtr]$root.Current.NativeWindowHandle, 3) # SW_MAXIMIZE
    # A fixed sleep here measured whatever the window happened to be mid-layout, and the
    # caller then read a window that had not finished maximizing as a graph that was not
    # visible. Wait for the size to settle instead, and say what it reached if it never does.
    $settle = [DateTimeOffset]::UtcNow.AddSeconds(8)
    $last = $null
    do {
        Start-Sleep -Milliseconds 150
        $b = $root.Current.BoundingRectangle
        $size = "$([int]$b.Width)x$([int]$b.Height)"
        if ($size -eq $last -and [int]$b.Width -ge 1200 -and [int]$b.Height -ge 800) { exit 0 }
        $last = $size
    } while ([DateTimeOffset]::UtcNow -lt $settle)
    throw "The window did not maximize: it settled at $last. A maximized window is what this step measures."
}
if ($Action -in @('MinimumSize', 'Compact', 'Wide')) {
    $width = if ($Action -eq 'Compact') { 640 } elseif ($Action -eq 'Wide') { 1600 } else { 1024 }
    $height = if ($Action -eq 'Wide') { 1000 } else { 720 }
    if (-not [ExtensionFocusProbe]::SetWindowPos([IntPtr]$root.Current.NativeWindowHandle, [IntPtr]::Zero, 0, 0, $width, $height, 22)) { throw 'Window resize failed.' }
    # The application clamps to its minimum asynchronously; give the clamp time to land before anyone measures.
    $settle = [DateTimeOffset]::UtcNow.AddSeconds(3)
    do {
        $b = $root.Current.BoundingRectangle
        if ([int]$b.Width -ge 1024 -and [int]$b.Height -ge 720) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTimeOffset]::UtcNow -lt $settle)
    if ([int]$b.Width -lt 1024 -or [int]$b.Height -lt 720) { throw "The window did not clamp to its minimum after a $width x $height request: measured $([int]$b.Width) x $([int]$b.Height)." }
    Start-Sleep -Milliseconds 400
    exit 0
}
# The contained renderer is a child HWND of the main window owned by the helper process, so its
# accessibility tree hangs off that child rather than off the XAML pane. Address it by process identity.
function Get-GraphRoot {
    foreach ($child in @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $true_))) {
        if ($child.Current.NativeWindowHandle -eq 0 -or $child.Current.ProcessId -eq $TargetProcessId) { continue }
        $owner = Get-Process -Id $child.Current.ProcessId -ErrorAction SilentlyContinue
        if ($null -ne $owner -and $owner.ProcessName -eq 'Nendo.ExtensionHost') { return $child }
    }
    return $null
}
$graph = Get-GraphRoot
for ($attempt = 0; $attempt -lt 50 -and $null -eq $graph; $attempt++) { Start-Sleep -Milliseconds 100; $graph = Get-GraphRoot }
$graphElements = @()
if ($null -ne $graph) {
    $graphElements = @($graph.FindAll($descendants, $true_))
    # Chromium builds its accessibility tree lazily after the first native client attaches.
    # Keep that client alive while asking for the actual record, rather than treating the
    # initial document-only tree as the completed tree.
    for ($attempt = 0; $attempt -lt 24 -and -not @($graphElements | Where-Object { $_.Current.Name -in @('Unchanged', 'Changed through Studio') }).Count; $attempt++) {
        Start-Sleep -Milliseconds 125
        $graphElements = @($graph.FindAll($descendants, $true_))
    }
}
# The pane's own elements: the six toolbar buttons and the notice, all owned by the host process.
$paneNames = @('Open record', 'Focus graph', 'Refresh', 'Studio', 'Disable view', 'Close')
$paneButtons = @($hostElements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -in $paneNames -and $_.Current.AutomationId -ne 'Close' })
$notice = @($hostElements | Where-Object { $_.Current.AutomationId -eq 'extensions.notice' }) | Select-Object -First 1
$paneElements = @($paneButtons) + @($notice | Where-Object { $_ })
$elements = @($paneElements) + @($graphElements)
# Pane bounds: the union of its controls and the composed viewport.
$paneRects = @($paneElements | ForEach-Object { $_.Current.BoundingRectangle }) + @(if ($null -ne $graph) { $graph.Current.BoundingRectangle })
$paneBounds = [System.Windows.Rect]::Empty
foreach ($r in $paneRects) { if ($paneBounds.IsEmpty) { $paneBounds = $r } else { $paneBounds.Union($r) } }
if ($Action -eq 'Crash renderer') {
    if (-not $OwnedRunRoot) { throw 'An explicit owned renderer root is required.' }
    if ($null -eq $graph) { throw 'No contained helper is composed in the pane.' }
    $ownedRoot = (Resolve-Path -LiteralPath $OwnedRunRoot).Path.TrimEnd('\') + '\'
    $repoArtifacts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts')).TrimEnd('\') + '\'
    if (-not $ownedRoot.StartsWith($repoArtifacts, [StringComparison]::OrdinalIgnoreCase)) { throw 'The renderer root must stay in task artifacts.' }
    $helper = Get-Process -Id $graph.Current.ProcessId
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($helper.Id)"
    if (-not $helper.Path.StartsWith($ownedRoot, [StringComparison]::OrdinalIgnoreCase) -or $parent.ParentProcessId -ne $TargetProcessId) {
        throw 'The helper is outside the owned run or has a different parent.'
    }
    $tree = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
    $parents = [System.Collections.Generic.Queue[int]]::new()
    $parents.Enqueue($helper.Id)
    while ($parents.Count) {
        $parentId = $parents.Dequeue()
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentId")) {
            $process = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
            if ($null -ne $process) { $tree.Add($process); $parents.Enqueue($process.Id) }
        }
        if ($tree.Count -gt 32) { throw 'The owned renderer tree exceeded its process bound.' }
    }
    if (-not $tree.Count) { throw 'No browser descendants were observed before the crash.' }
    Stop-Process -Id $helper.Id -Force
    if (-not $helper.WaitForExit(5000)) { throw 'The owned helper did not stop.' }
    $exitDeadline = [DateTimeOffset]::UtcNow.AddSeconds(5)
    foreach ($process in $tree) {
        if (-not $process.WaitForExit([int][Math]::Max(0, ($exitDeadline - [DateTimeOffset]::UtcNow).TotalMilliseconds))) {
            throw "A browser descendant survived helper crash: $($process.Id)."
        }
        $process.Dispose()
    }
    exit 0
}
# The same boundary, moved the way a person moves it. This is a separate action from the
# arrow keys on purpose: the two reach different handlers, and the owner reported on
# 2026-09-21 that the drag did nothing while the keyboard path was already passing.
if ($Action -eq 'Drag pane') {
    if ($DragBy -eq 0) { throw 'A drag needs a distance.' }
    $splitter = @($hostElements | Where-Object { $_.Current.AutomationId -eq 'extensions.splitter' }) | Select-Object -First 1
    if ($null -eq $splitter) {
        throw "The boundary beside the pane is not reachable. Seen: $(@($hostElements | ForEach-Object { $_.Current.AutomationId } | Where-Object { $_ }) -join ', ')"
    }
    # Per-monitor aware for the rest of this action, so the cursor calls below are in the
    # same pixels the accessibility rectangle is given in.
    $previousDpi = [ExtensionFocusProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
    $handle = [IntPtr]$root.Current.NativeWindowHandle
    # A window that is not foreground receives the moves but not the press.
    [uint32]$owner = 0
    $current = [ExtensionFocusProbe]::GetForegroundWindow()
    $from = [ExtensionFocusProbe]::GetWindowThreadProcessId($current, [ref]$owner)
    $to = [ExtensionFocusProbe]::GetWindowThreadProcessId($handle, [ref]$owner)
    [void][ExtensionFocusProbe]::AttachThreadInput($from, $to, $true)
    [void][ExtensionFocusProbe]::SetForegroundWindow($handle)
    [void][ExtensionFocusProbe]::AttachThreadInput($from, $to, $false)
    Start-Sleep -Milliseconds 250
    $bounds = $splitter.Current.BoundingRectangle
    if ($bounds.Width -lt 1 -or $bounds.Height -lt 1) { throw "The boundary has no hit area: $($bounds.Width)x$($bounds.Height)." }
    $startX = [int]($bounds.Left + $bounds.Width / 2)
    $startY = [int]($bounds.Top + $bounds.Height / 2)
    $before = [ExtensionFocusProbe+Point]::new()
    [void][ExtensionFocusProbe]::GetCursorPos([ref]$before)
    # Absolute injected input across the whole virtual desktop. SetCursorPos moves the
    # cursor without producing pointer input a captured element sees, and a relative move
    # of zero produces nothing at all: the first attempt delivered the press and then one
    # move at the press position, which is a drag that never moves.
    $originX = [ExtensionFocusProbe]::GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
    $originY = [ExtensionFocusProbe]::GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
    $spanX = [ExtensionFocusProbe]::GetSystemMetrics(78)     # SM_CXVIRTUALSCREEN
    $spanY = [ExtensionFocusProbe]::GetSystemMetrics(79)     # SM_CYVIRTUALSCREEN
    function Send-Mouse([uint32] $flags, [int] $x = 0, [int] $y = 0) {
        $item = [ExtensionFocusProbe+Input]::new()
        $item.type = 0
        $mouse = [ExtensionFocusProbe+MouseInput]::new()
        $mouse.flags = $flags
        if ($flags -band 0x8000) {
            $mouse.dx = [int][Math]::Round((($x - $originX) * 65535.0) / [Math]::Max(1, $spanX - 1))
            $mouse.dy = [int][Math]::Round((($y - $originY) * 65535.0) / [Math]::Max(1, $spanY - 1))
        }
        $item.mouse = $mouse
        if ([ExtensionFocusProbe]::SendInput(1, @($item), [Runtime.InteropServices.Marshal]::SizeOf($item)) -ne 1) {
            throw 'The owned pointer event was refused.'
        }
    }
    $move = 0x0001 -bor 0x8000 -bor 0x4000   # MOVE | ABSOLUTE | VIRTUALDESK
    try {
        Send-Mouse $move $startX $startY
        Start-Sleep -Milliseconds 150
        Send-Mouse 0x0002  # left down
        Start-Sleep -Milliseconds 150
        # In steps, because a single jump is not a drag: a captured pointer needs moves
        # between the press and the release. Roughly one every six pixels, so a long drag
        # delivers as many moves as a hand would rather than the same dozen stretched out.
        $steps = [int][Math]::Max(12, [Math]::Min(80, [Math]::Abs($DragBy) / 6))
        for ($step = 1; $step -le $steps; $step++) {
            Send-Mouse $move ($startX + [int]($DragBy * $step / $steps)) $startY
            Start-Sleep -Milliseconds 40
        }
        Start-Sleep -Milliseconds 150
    }
    finally {
        Send-Mouse 0x0004  # left up
        Start-Sleep -Milliseconds 250
        [void][ExtensionFocusProbe]::SetCursorPos($before.X, $before.Y)
        [void][ExtensionFocusProbe]::SetThreadDpiAwarenessContext($previousDpi)
    }
    exit 0
}
# Moving the boundary between the Workbench and the pane from the keyboard, which UI
# Automation can drive where it cannot drive a drag.
if ($Action -eq 'Resize pane') {
    if ($ResizeSteps -eq 0) { throw 'A resize needs a number of steps.' }
    $splitter = @($hostElements | Where-Object { $_.Current.AutomationId -eq 'extensions.splitter' }) | Select-Object -First 1
    if ($null -eq $splitter) {
        throw "The boundary beside the pane is not reachable. Seen: $(@($hostElements | ForEach-Object { $_.Current.AutomationId } | Where-Object { $_ }) -join ', ')"
    }
    $splitter.SetFocus()
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused.Current.AutomationId -ne 'extensions.splitter') {
        throw "The boundary refused keyboard focus; it went to '$($focused.Current.Name)'."
    }
    $key = if ($ResizeSteps -gt 0) { 0x25 } else { 0x27 }  # Left widens the pane, Right narrows it.
    [uint32]$owner = 0
    $thread = [ExtensionFocusProbe]::GetWindowThreadProcessId([IntPtr]$root.Current.NativeWindowHandle, [ref]$owner)
    $info = [ExtensionFocusProbe+ThreadInfo]::new()
    $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [ExtensionFocusProbe]::GetGUIThreadInfo($thread, [ref]$info) -or $info.Focus -eq [IntPtr]::Zero) {
        throw 'The owned window reports no keyboard focus.'
    }
    for ($press = 0; $press -lt [Math]::Abs($ResizeSteps); $press++) {
        if (-not [ExtensionFocusProbe]::PostMessage($info.Focus, 0x100, [IntPtr]$key, [IntPtr]1) -or
            -not [ExtensionFocusProbe]::PostMessage($info.Focus, 0x101, [IntPtr]$key, [IntPtr]0xC0000001)) {
            throw 'The owned arrow key message was refused.'
        }
        Start-Sleep -Milliseconds 20
    }
    Start-Sleep -Milliseconds 400
    exit 0
}
if ($Action -eq 'Inspect') {
    $bounds = $root.Current.BoundingRectangle
    $colors = $null
    if ($Capture) {
        $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
        $path = [IO.Path]::GetFullPath($Capture)
        if (-not $path.StartsWith((Join-Path $repo 'artifacts') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Capture must stay in task artifacts.' }
        Add-Type -AssemblyName System.Drawing
        $bitmap = [Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $dc = $graphics.GetHdc()
        try { if (-not [ExtensionFocusProbe]::PrintWindow([IntPtr]$root.Current.NativeWindowHandle, $dc, 2)) { throw 'Owned window capture failed.' } }
        finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
        try {
            # Sample the pane's own frame (its notice row) and, inside the composed viewport, the page's left
            # padding column near the bottom: the footer text starts about 18 px in, so stay well left of it.
            # After a helper crash there is no composed renderer, and that inspection asks about the notice, not colors.
            $native = $bitmap.GetPixel([int]($paneBounds.Left - $bounds.Left + 20), [int]($paneBounds.Top - $bounds.Top + 80))
            $rendererColor = $null
            if ($null -ne $graph) {
                $viewport = $graph.Current.BoundingRectangle
                $renderer = $bitmap.GetPixel([int]($viewport.Left - $bounds.Left + 6), [int]($viewport.Bottom - $bounds.Top - 40))
                $rendererColor = "$($renderer.R),$($renderer.G),$($renderer.B)"
            }
            $colors = @{ Native = "$($native.R),$($native.G),$($native.B)"; Renderer = $rendererColor }
            $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png)
        } finally { $bitmap.Dispose() }
    }
    $buttons = @($paneButtons)
    foreach ($button in $buttons) {
        $r = $button.Current.BoundingRectangle
        if ($button.Current.IsOffscreen -or $r.Left -lt $bounds.Left -or $r.Right -gt $bounds.Right -or $r.Top -lt $bounds.Top -or $r.Bottom -gt $bounds.Bottom) { throw 'A native graph control is clipped.' }
    }
    $inspection = @{ Buttons = @($buttons | ForEach-Object { $_.Current.Name }); Text = @($elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ });
        Focused = [System.Windows.Automation.AutomationElement]::FocusedElement.Current.Name;
        OpenRecordEnabled = @($buttons | Where-Object { $_.Current.Name -eq 'Open record' })[0].Current.IsEnabled;
        Colors = $colors; Window = @{ Width = $bounds.Width; Height = $bounds.Height };
        Dpi = [ExtensionFocusProbe]::GetDpiForWindow([IntPtr]$root.Current.NativeWindowHandle);
        # Private bytes over the contained tree, in MiB. The Job's cap is what stops a view,
        # so a lane that only sees "it stopped" cannot say whether a change helped.
        MemoryMib = $(
            if ($null -eq $graph) { -1 } else {
                $ids = [Collections.Generic.List[int]]::new()
                $queue = [Collections.Generic.Queue[int]]::new()
                $queue.Enqueue([int]$graph.Current.ProcessId)
                while ($queue.Count -and $ids.Count -lt 64) {
                    $id = $queue.Dequeue(); $ids.Add($id)
                    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue)) { $queue.Enqueue([int]$child.ProcessId) }
                }
                [int](((@($ids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).PrivateMemorySize64 }) | Measure-Object -Sum).Sum) / 1MB)
            });
        # The boundary's own box, so "nothing to grab" is diagnosable rather than a guess.
        Splitter = $(
            $s = @($hostElements | Where-Object { $_.Current.AutomationId -eq 'extensions.splitter' }) | Select-Object -First 1
            if ($null -eq $s) { $null } else {
                $sr = $s.Current.BoundingRectangle
                @{ Width = $(if ($sr.IsEmpty) { -1 } else { $sr.Width }); Height = $(if ($sr.IsEmpty) { -1 } else { $sr.Height })
                   Offscreen = $s.Current.IsOffscreen; ControlType = ($s.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')
                   Name = $s.Current.Name
                   Under = $(if ($sr.IsEmpty) { 'no box' } else { [ExtensionFocusProbe]::ClassAt([int]($sr.Left + $sr.Width / 2), [int]($sr.Top + $sr.Height / 2)) })
                   MainWindow = "$($root.Current.ClassName)/$TargetProcessId" }
            });
        Pane = @{ Width = $paneBounds.Width; Height = $paneBounds.Height } } | ConvertTo-Json -Depth 5 -Compress
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($inspection))
    exit 0
}
if ($Action -eq 'Return focus') {
    $focus = [System.Windows.Automation.AutomationElement]::FocusedElement
    $handle = [IntPtr]$focus.Current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero) {
        if ($null -eq $graph) { throw 'No contained renderer HWND is exposed.' }
        $handle = [IntPtr]$graph.Current.NativeWindowHandle
    }
    [uint32]$owner = 0
    $thread = [ExtensionFocusProbe]::GetWindowThreadProcessId($handle, [ref]$owner)
    $info = [ExtensionFocusProbe+ThreadInfo]::new()
    $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [ExtensionFocusProbe]::GetGUIThreadInfo($thread, [ref]$info) -or $info.Focus -eq [IntPtr]::Zero -or
        [ExtensionFocusProbe]::GetAncestor($info.Focus, 2) -ne [IntPtr]$root.Current.NativeWindowHandle) { throw 'Keyboard focus is outside the owned main window.' }
    if (-not [ExtensionFocusProbe]::PostMessage($info.Focus, 0x100, [IntPtr]0x75, [IntPtr]1) -or
        -not [ExtensionFocusProbe]::PostMessage($info.Focus, 0x101, [IntPtr]0x75, [IntPtr]0xC0000001)) { throw 'The owned F6 key message was refused.' }
    exit 0
}
$name = if ($Action -eq 'Select node') { 'Unchanged' } else { $Action }
$pool = if ($Action -eq 'Select node') { $graphElements } else { $paneButtons }
$button = @($pool | Where-Object { $_.Current.Name -eq $name -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button }) | Select-Object -First 1
if ($null -eq $button) { throw "The graph action is missing: $name. Seen: $(@($elements | ForEach-Object { $_.Current.Name }) -join ', ')" }
if ($Action -ne 'Select node' -and $button.Current.ProcessId -ne $TargetProcessId) { throw 'A host control belongs to the wrong process.' }
$button.SetFocus()
$pattern = $null
if ($Action -eq 'Select node' -and $button.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.TogglePattern]$pattern).Toggle()
} else {
    ([System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
}
