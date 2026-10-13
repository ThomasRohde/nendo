# Shared by the lanes that drive a real Nendo.Desktop process. Dot-source it:
#   . (Join-Path $PSScriptRoot 'Lane-NativeHost.ps1')

# The teardown every native lane uses. A failure with a native dialog still open blocks
# the close, and a throw from a finally block replaces the failure already on its way
# out: the lane then reported only "did not close normally", lost its assertion and its
# evidence path, and left the process holding the evidence file, its browser profile and
# the debugging port. So the owned process is stopped and the lane says so, and the
# teardown throws only when the lane had otherwise passed.
function Stop-OwnedNendo($Target, [bool] $Succeeded, [string] $Label = 'Nendo') {
    if ($null -eq $Target -or $Target.HasExited) { return }
    if ($Target.CloseMainWindow() -and $Target.WaitForExit(15000)) { return }
    $Target.Kill($true)
    Write-Warning "Owned $Label PID $($Target.Id) did not close normally and was stopped; no other process was touched."
    if ($Succeeded) { throw "Owned $Label PID $($Target.Id) did not close normally and was stopped." }
}

# What a lane must never write in the owner's device state: the theme, and a kept agent
# port for one of its own files. A lane whose host ran without a device-state root of its
# own wrote both. The owner's Nendo rewrites agent-ports.json on every file open, so the
# lane looks for its own traces there -- a port kept under one of its file names that was
# not there before -- rather than comparing the file. The theme is compared by its value,
# which only a theme choice changes. -Root is for the check of these functions themselves.
function Get-OwnerDeviceSnapshot([string] $Root = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Nendo')) {
    $appearance = Join-Path $Root 'appearance.json'
    $ports = Join-Path $Root 'agent-ports.json'
    $preference = if (Test-Path -LiteralPath $appearance -PathType Leaf) { [string](Get-Content -LiteralPath $appearance -Raw | ConvertFrom-Json).Preference } else { 'absent' }
    $kept = @{}
    if (Test-Path -LiteralPath $ports -PathType Leaf) {
        $files = (Get-Content -LiteralPath $ports -Raw | ConvertFrom-Json).Files
        if ($null -ne $files) { foreach ($entry in $files.PSObject.Properties) { $kept[$entry.Name] = [string]$entry.Value.Name } }
    }
    return [pscustomobject]@{ Root = $Root; Preference = $preference; Ports = $kept }
}
function Assert-OwnerDeviceUnchanged($Before, [string[]] $LaneFiles, [string] $Lane) {
    $after = Get-OwnerDeviceSnapshot $Before.Root
    if ($after.Preference -ne $Before.Preference) {
        throw "$Lane changed the owner's theme in $($Before.Root)\appearance.json from $($Before.Preference) to $($after.Preference) (or the owner chose a theme while it ran)."
    }
    $traces = @(foreach ($id in $after.Ports.Keys) {
        if (-not $Before.Ports.ContainsKey($id) -and $LaneFiles -contains $after.Ports[$id]) { "$id ($($after.Ports[$id]))" }
    })
    if ($traces.Count -gt 0) {
        throw "$Lane kept an agent port for its own file in the owner's $($Before.Root)\agent-ports.json: $($traces -join ', ')"
    }
}
