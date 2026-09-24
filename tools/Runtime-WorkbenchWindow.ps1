[CmdletBinding()]
param(
    [Parameter(Mandatory)][int] $TargetProcessId,
    [Parameter(Mandatory)][ValidateSet('MinimumSize', 'Maximize', 'Cancel', 'Close', 'Close file', 'Save', 'Create duplicate', 'Create fork', 'Restore backup', 'Continue', 'Open', 'Open read-only', 'Inspect', 'Inspect read-only', 'Upgrade file', 'Export CSV', 'Export partial CSV', 'Continue anyway', 'Change folder', 'Choose another file', 'Open original', 'Validate first batch', 'Cancel remaining import', 'Review', 'Allow this view', 'Keep permission', 'Install package')][string] $Action,
    [string] $ExpectedTitle,
    [string] $FileName,
    [ValidateSet('file.confirmation', 'extensions.manage', 'extensions.install', 'extensions.consent', 'extensions.choose')][string] $DialogId = 'file.confirmation',
    [ValidateSet('Review permission for a view', 'Disable a view', 'Open a custom view', 'Install an offline package', 'Export an installed package')][string] $CustomViewAction,
    [switch] $Base64Inspection,
    [string] $Executable = $env:NENDO_RUNTIME_EXPECTED_EXECUTABLE
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedExe = if ($Executable) { (Resolve-Path -LiteralPath $Executable).Path } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe')) }
$target = Get-Process -Id $TargetProcessId
if ($target.Path -ne $expectedExe -or $target.MainWindowHandle -eq 0) { throw 'The target is not the owned Nendo executable/window.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.ControlType].Assembly.Location,
    (Join-Path $PSHOME 'ref/System.Runtime.dll'),
    (Join-Path $PSHOME 'ref/System.Threading.Tasks.dll')
) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Automation;
public static class P4WorkbenchWindow {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int cmd);
    public static Task InvokeAsync(AutomationElement element) => Task.Run(() => ((InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern)).Invoke());
}
'@
if ($Action -eq 'MinimumSize') {
    if (-not [P4WorkbenchWindow]::SetWindowPos($target.MainWindowHandle, [IntPtr]::Zero, 0, 0, 1024, 720, 22)) { throw 'Nendo window resize failed.' }
    exit 0
}
if ($Action -eq 'Maximize') {
    [void][P4WorkbenchWindow]::ShowWindow($target.MainWindowHandle, 3) # SW_MAXIMIZE
    Start-Sleep -Milliseconds 700
    exit 0
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $DialogId)
# The package manager offers plain buttons, so a custom-view action is the button to press.
if ($CustomViewAction -and $DialogId -ne 'extensions.manage') { throw 'A custom-view action belongs only to the package manager.' }
$name = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $(if ($CustomViewAction) { $CustomViewAction } else { $Action }))
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
$button = $null
$matched = $false
while ($null -eq $button -and [DateTimeOffset]::UtcNow -lt $deadline) {
    $dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -ne $dialog -and ($null -eq $ExpectedTitle -or $ExpectedTitle -eq '' -or
        $null -ne $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $ExpectedTitle)))) {
        $matched = $true
        if ($Action -eq 'Inspect') { break }
        $button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $name)
    }
    if ($null -eq $button) { Start-Sleep -Milliseconds 50 }
}
if (-not $matched -or $null -eq $dialog -or $dialog.Current.ProcessId -ne $target.Id) { throw 'The owned file dialog is unavailable.' }
if ($FileName) {
    if ($FileName -ne [IO.Path]::GetFileName($FileName) -or $FileName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw 'Only a simple filename is allowed.' }
    $edit = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'file.destinationName'))
    if ($null -eq $edit -or $edit.Current.ProcessId -ne $target.Id) { throw 'The owned filename field is unavailable.' }
    $value = [System.Windows.Automation.ValuePattern]$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($FileName)
    if ($value.Current.Value -ne $FileName) { throw 'Filename entry was not retained.' }
}
if ($Action -eq 'Inspect') {
    $bounds = $root.Current.BoundingRectangle
    $elements = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $buttons = @($elements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button })
    foreach ($item in $buttons) {
        $r = $item.Current.BoundingRectangle
        if ($item.Current.IsOffscreen -or $r.Bottom -gt $bounds.Bottom -or $r.Top -lt $bounds.Top) {
            throw "A native dialog action is clipped: '$($item.Current.Name)' at $r (offscreen $($item.Current.IsOffscreen)) in a window at $bounds."
        }
    }
    # A dialog that lists what it can do draws each one as a row. Where its label starts is the
    # difference between a list of choices and a stack of centred default buttons, and it is the
    # only part of that the eye checks which a rectangle can carry.
    $rows = @($buttons | Where-Object { $_.Current.AutomationId -like 'extensions.action.*' } | ForEach-Object {
        $r = $_.Current.BoundingRectangle
        $label = $_.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text))
        @{
            Id = $_.Current.AutomationId; Name = $_.Current.Name
            Left = [int] $r.Left; Width = [int] $r.Width; Height = [int] $r.Height
            LabelOffset = if ($null -eq $label) { -1 } else { [int] ($label.Current.BoundingRectangle.Left - $r.Left) }
        }
    })
    $inspection = @{ Text = @($elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ }); Buttons = @($buttons | ForEach-Object { $_.Current.Name }); Rows = $rows } | ConvertTo-Json -Depth 4 -Compress
    if ($Base64Inspection) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($inspection)) } else { $inspection }
    exit 0
}
if ($null -eq $button -or $button.Current.ProcessId -ne $target.Id -or -not $button.Current.IsEnabled) { throw 'The owned file confirmation is unavailable.' }
$invocation = [P4WorkbenchWindow]::InvokeAsync($button)
if (-not $invocation.Wait(10000)) { throw 'The owned confirmation did not complete.' }
