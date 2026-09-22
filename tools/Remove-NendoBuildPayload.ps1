[CmdletBinding()]
param([Parameter(Mandatory)][string[]] $BuildRoot, [switch] $Apply, [switch] $IncludeInstaller)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$artifacts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts')).TrimEnd('\')
foreach ($candidate in $BuildRoot) {
    $root = (Resolve-Path -LiteralPath $candidate).Path.TrimEnd('\')
    if (-not $root.StartsWith($artifacts + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Only repository artifacts can be pruned.' }
    $payload = Join-Path $root 'payload'
    $manifestPath = Join-Path $root 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.kind -ne 'local-pilot') { throw 'Unrecognized build manifest.' }
    foreach ($item in @(Get-Item -LiteralPath $root) + @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked artifact retained: $($item.FullName)" }
    }
    $files = @()
    foreach ($entry in $manifest.files) {
        if ([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)|:') { throw 'Unsafe manifest path.' }
        $file = [IO.Path]::GetFullPath((Join-Path $payload $entry.path))
        if (-not $file.StartsWith($payload + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escapes payload.' }
        if (Test-Path -LiteralPath $file) {
            if ((Get-FileHash -LiteralPath $file).Hash -ne $entry.sha256) { throw "Changed artifact retained: $file" }
            $files += Get-Item -LiteralPath $file
        }
    }
    if ($IncludeInstaller -and (Test-Path -LiteralPath (Join-Path $root 'installer.json'))) {
        $setup = Get-Content -LiteralPath (Join-Path $root 'installer.json') -Raw | ConvertFrom-Json
        $exe = [IO.Path]::GetFullPath($setup.installer)
        # Stable current/previous installers outside this build directory are always retained.
        if ($exe.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $exe)) {
            if ((Get-FileHash -LiteralPath $exe).Hash -ne $setup.sha256) { throw 'Changed installer retained.' }
            $files += Get-Item -LiteralPath $exe
        }
    }
    $bytes = if ($files.Count) { [long](($files | Measure-Object Length -Sum).Sum) } else { [long]0 }
    if ($Apply) {
        foreach ($file in $files) { Remove-Item -LiteralPath $file.FullName }
        if (Test-Path -LiteralPath $payload) {
            foreach ($dir in @(Get-ChildItem -LiteralPath $payload -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending) + @(Get-Item -LiteralPath $payload)) {
                if (@(Get-ChildItem -LiteralPath $dir.FullName -Force).Count -eq 0) { [IO.Directory]::Delete($dir.FullName, $false) }
            }
        }
        @{prunedUtc=[DateTime]::UtcNow.ToString('O'); removedBytes=$bytes; removedFiles=@($files | ForEach-Object { $_.FullName }); manifestSha256=(Get-FileHash -LiteralPath $manifestPath).Hash; preserved='Manifest, logs, fixtures and unrecognized files retained.'} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'payload-pruned.json')
    }
    [pscustomobject]@{root=$root; files=$files.Count; bytes=$bytes; applied=[bool]$Apply}
}
