# Measures a cold open with and without 2 GiB of embedded pictures (W-264, ADR-0031 point 7).
# Builds the two fixtures under artifacts/media-open/ unless they exist, then runs each file and
# mode on a fresh unbuffered copy (robocopy /J), alternating, and prints the medians. Run it from
# the repository root through the PowerShell tool, with nothing else building.
param([int] $Runs = 7, [int] $BaseMiB = 200, [int] $MediaMiB = 2048)
$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'MediaOpen.cs'
$work = Join-Path (Resolve-Path "$PSScriptRoot/../..") 'artifacts/media-open'
New-Item -ItemType Directory -Force $work | Out-Null
if (-not (Test-Path (Join-Path $work 'fixtures/media.sqlite'))) {
    dotnet run $tool -- build (Join-Path $work 'fixtures') $BaseMiB $MediaMiB
}
$rows = @()
foreach ($run in 1..$Runs) {
    foreach ($file in 'base.sqlite', 'media.sqlite') {
        foreach ($mode in 'left-out', 'full') {
            $cold = Join-Path $work 'cold'
            Remove-Item -Recurse -Force $cold -ErrorAction SilentlyContinue
            robocopy (Join-Path $work 'fixtures') $cold $file /J /NJH /NJS /NFL /NDL /NP | Out-Null
            $line = dotnet run $tool -- measure (Join-Path $cold $file) $mode | Select-Object -Last 1
            $rows += $line | ConvertFrom-Json
        }
    }
}
Remove-Item -Recurse -Force (Join-Path $work 'cold') -ErrorAction SilentlyContinue
function Median($values) { $sorted = @($values | Sort-Object); $sorted[[int][math]::Floor(($sorted.Count - 1) / 2)] }
foreach ($mode in 'left-out', 'full') {
    $key = if ($mode -eq 'full') { 'fullCheckMs' } else { 'openWithMediaLeftOutMs' }
    $base = Median ($rows | Where-Object { $_.file -eq 'base.sqlite' -and $_.mode -eq $mode } | ForEach-Object { $_.$key })
    $media = Median ($rows | Where-Object { $_.file -eq 'media.sqlite' -and $_.mode -eq $mode } | ForEach-Object { $_.$key })
    '{0,-9} base {1,6} ms  media {2,6} ms  ratio {3:N3}' -f $mode, $base, $media, ($media / $base)
}
