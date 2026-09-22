[CmdletBinding()]
param([Parameter(Mandatory)][int] $TargetProcessId, [string] $ExpectedExecutable)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expected = Join-Path $repoRoot 'artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe'
if ($ExpectedExecutable) { $expected = (Resolve-Path -LiteralPath $ExpectedExecutable).Path }
if ([IO.Path]::GetFileName($expected) -ne 'Nendo.Desktop.exe') { throw 'Expected a Nendo Desktop executable.' }
$target = Get-Process -Id $TargetProcessId -ErrorAction Stop
if ($target.Path -ne $expected) { throw 'The memory sample target is not the owned Nendo build.' }
$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$owned = [Collections.Generic.HashSet[int]]::new()
[void] $owned.Add($TargetProcessId)
do {
    $added = $false
    foreach ($row in $rows) {
        if ($owned.Contains([int] $row.ParentProcessId) -and $owned.Add([int] $row.ProcessId)) { $added = $true }
    }
} while ($added)
$samples = @($owned | ForEach-Object {
    $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
    if ($null -ne $process) {
        [pscustomobject]@{ id=$process.Id; name=$process.ProcessName; privateBytes=$process.PrivateMemorySize64; workingBytes=$process.WorkingSet64 }
    }
})
[pscustomobject]@{ sampledAtUtc=[DateTimeOffset]::UtcNow.ToString('O'); processes=$samples;
    privateBytes=($samples | Measure-Object -Property privateBytes -Sum).Sum;
    workingBytes=($samples | Measure-Object -Property workingBytes -Sum).Sum } | ConvertTo-Json -Depth 5 -Compress
