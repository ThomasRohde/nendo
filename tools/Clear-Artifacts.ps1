[CmdletBinding(SupportsShouldProcess)]
param(
    # What artifacts/ keeps whatever its age: the .NET build output (ArtifactsPath), the
    # current payload (pruned by Remove-NendoBuildPayload.ps1, which hash-checks it), the
    # installer with its rollback copy, and the gate's progress and step timings.
    [string] $Root = (Join-Path $PSScriptRoot '..\artifacts'),
    # An entry with anything written more recently than this may belong to a run another
    # session has going, so it stays until a later sweep.
    [TimeSpan] $OlderThan = [TimeSpan]::FromHours(12)
)

# artifacts/ is scratch (AGENTS.md): every lane writes its logs and run folders here and
# none reads another's, so they pile up. The full gate sweeps it at its start.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$keep = @('bin', 'obj', 'build', 'installer', 'gate-progress.json', 'gate-timings.json')
$Root = [IO.Path]::GetFullPath($Root)
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
$cutoff = [DateTime]::Now - $OlderThan

function Get-LastWrite([IO.FileSystemInfo] $Entry) {
    if (-not $Entry.PSIsContainer) { return $Entry.LastWriteTime }
    $newest = $Entry.LastWriteTime
    foreach ($item in Get-ChildItem -LiteralPath $Entry.FullName -Recurse -Force -ErrorAction SilentlyContinue) {
        if ($item.LastWriteTime -gt $newest) { $newest = $item.LastWriteTime }
    }
    return $newest
}

$removed = 0
$bytes = 0L
foreach ($entry in Get-ChildItem -LiteralPath $Root -Force) {
    if ($keep -contains $entry.Name) { continue }
    if ((Get-LastWrite $entry) -gt $cutoff) { continue }
    $size = 0L
    if ($entry.PSIsContainer) {
        foreach ($file in Get-ChildItem -LiteralPath $entry.FullName -Recurse -File -Force -ErrorAction SilentlyContinue) { $size += $file.Length }
    } else { $size = $entry.Length }
    if (-not $PSCmdlet.ShouldProcess($entry.FullName, 'Remove')) { continue }
    try {
        Remove-Item -LiteralPath $entry.FullName -Recurse -Force
        $removed++
        $bytes += $size
    } catch {
        # A file a running process still holds is left for the next sweep.
        Write-Warning "Kept $($entry.Name): $($_.Exception.Message)"
    }
}
Write-Host ("Cleared {0} entries from artifacts ({1:N0} MB)." -f $removed, ($bytes / 1MB))
