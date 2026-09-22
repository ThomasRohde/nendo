[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Source,
    [Parameter(Mandatory = $true)][string] $PackageId,
    [Parameter(Mandatory = $true)][string] $PackageVersion,
    [Parameter(Mandatory = $true)][string[]] $Assets,
    [string] $EntryPoint = 'index.html',
    [string] $License = 'MIT'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# One packer for every custom-view package. The digest of the archive is the identity a file
# pins, so nothing here may vary between runs over unchanged source: entry timestamps and
# attributes are fixed, the entry order is manifest-first then $Assets as given, and the
# manifest's own key order is fixed by this ordered map.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $repoRoot $Source
$output = Join-Path $repoRoot 'artifacts/extensions'
[void][IO.Directory]::CreateDirectory($output)
if ($Assets -notcontains $EntryPoint) { throw "The entry point $EntryPoint is not one of the declared assets." }
$inventory = @($Assets | ForEach-Object {
    $path = Join-Path $sourcePath $_
    [ordered]@{ path = $_; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$manifest = [ordered]@{
    manifestVersion = 1; packageId = $PackageId; version = $PackageVersion; protocolVersion = 1
    entryPoint = $EntryPoint; capabilities = @('projection.read', 'record.select'); license = $License; assets = $inventory
}
$target = Join-Path $output "$PackageId-$PackageVersion.nendoview"
$stage = Join-Path $output ('package-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    $stream = [IO.File]::Open($stage, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($name in @('manifest.json') + $Assets) {
                $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
                $entry.ExternalAttributes = 0
                $bytes = if ($name -eq 'manifest.json') { [Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 5 -Compress)) } else { [IO.File]::ReadAllBytes((Join-Path $sourcePath $name)) }
                $entryStream = $entry.Open()
                try { $entryStream.Write($bytes, 0, $bytes.Length) } finally { $entryStream.Dispose() }
            }
        } finally { $zip.Dispose() }
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    [IO.File]::Move($stage, $target, $true)
    Write-Output "Package: $target"
    Write-Output "SHA-256: $((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant())"
} finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage } }
