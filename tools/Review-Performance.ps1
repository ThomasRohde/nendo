[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Generate', 'Measure', 'MeasureCandidate', 'MeasureBehaviour')][string] $Mode,
    [Parameter(Mandatory)][ValidateSet(1000, 10000)][int] $Records,
    [Parameter(Mandatory)][ValidateSet(1000, 10000)][int] $Revisions,
    [Parameter(Mandatory)][string] $OutputRoot,
    [string] $EngineAssembly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts')) + [IO.Path]::DirectorySeparatorChar
$evidenceRoot = [IO.Path]::GetFullPath($OutputRoot)
if (-not $evidenceRoot.StartsWith($artifactsRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Use an owned artifact directory.' }
[void] (New-Item -ItemType Directory -Path $evidenceRoot -Force)
$engineDirectory = Join-Path $repoRoot 'artifacts/bin/Nendo.Engine.Tests/debug'
$enginePath = if ($EngineAssembly) { (Resolve-Path -LiteralPath $EngineAssembly).Path } else { Join-Path $engineDirectory 'Nendo.Engine.dll' }
$filePath = Join-Path $evidenceRoot "records-$Records-history-$Revisions.nendo"
$reportPath = Join-Path $evidenceRoot "$($Mode.ToLowerInvariant())-$Records-$Revisions.json"
if (Test-Path -LiteralPath $reportPath) { throw 'This benchmark result already exists; keep it and choose a new run.' }
foreach ($assembly in @('SQLitePCLRaw.core.dll', 'SQLitePCLRaw.provider.e_sqlite3.dll',
        'SQLitePCLRaw.batteries_v2.dll', 'Microsoft.Data.Sqlite.dll', 'Nendo.Engine.dll',
        'MSTest.TestFramework.dll', 'Nendo.Engine.Tests.dll')) {
    $assemblyPath = if ($assembly -eq 'Nendo.Engine.dll') { $enginePath } else { Join-Path $engineDirectory $assembly }
    $loaded = [System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath($assemblyPath)
    if ($assembly -eq 'Nendo.Engine.dll' -and $loaded.Location -ne $enginePath) { throw 'Fixture did not load the requested Engine assembly.' }
}
# ADR-0008. The Engine evaluates calculations through NCalc, so a fixture that holds
# them needs its closure beside the Engine. Loaded explicitly rather than through a
# Resolving handler: resolving from inside the default load context while it is
# already resolving is not legal, and fails as a file-load error rather than a
# missing file.
foreach ($assembly in @('ExtendedNumerics.BigDecimal.dll', 'Microsoft.Extensions.DependencyInjection.Abstractions.dll',
        'Microsoft.Extensions.Logging.Abstractions.dll', 'Parlot.dll', 'NCalc.Domain.dll', 'NCalc.Parser.dll',
        'NCalc.Core.dll', 'NCalc.dll')) {
    $expressionPath = [IO.Path]::GetFullPath((Join-Path $engineDirectory $assembly))
    if (Test-Path -LiteralPath $expressionPath) {
        [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath($expressionPath)
    }
}
$nativeHandle = [Runtime.InteropServices.NativeLibrary]::Load((Join-Path $engineDirectory 'runtimes/win-x64/native/e_sqlite3.dll'))
# The document this run follows, hashed so a published number can be traced to the
# protocol it was taken under. The original qualification note was retired with the
# review it belonged to; the contract that states the ceilings is the standing one.
$protocolCandidates = @('docs/design/r06-performance-qualification.md', 'docs/contracts/calculations-and-actions.md')
$protocolPath = $protocolCandidates | ForEach-Object { Join-Path $repoRoot $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $protocolPath) { throw 'No measurement protocol document is present to record provenance against.' }
$provenance = [ordered]@{
    startedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    protocol = [IO.Path]::GetRelativePath($repoRoot, $protocolPath).Replace([char]92, [char]47)
    protocolSha256 = (Get-FileHash -LiteralPath $protocolPath -Algorithm SHA256).Hash.ToLowerInvariant()
    engineSha256 = (Get-FileHash -LiteralPath $enginePath -Algorithm SHA256).Hash.ToLowerInvariant()
    enginePath = $enginePath
    driverSha256 = (Get-FileHash -LiteralPath (Join-Path $engineDirectory 'Nendo.Engine.Tests.dll') -Algorithm SHA256).Hash.ToLowerInvariant()
    mode = $Mode
    records = $Records
    revisions = $Revisions
    status = 'not-completed'
}
try {
    $provenance | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath
    $result = [Nendo.Engine.Tests.ReviewPerformanceFixture]::RunAsync($filePath, $Records, $Revisions, $Mode).GetAwaiter().GetResult()
    $provenance.status = 'completed'
    $provenance.result = $result | ConvertFrom-Json
    Write-Host "$Mode completed for $Records records and $Revisions starting revisions."
}
catch {
    $provenance.status = 'failed'
    $provenance.error = $_.Exception.ToString()
    throw
}
finally {
    $provenance.finishedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    $provenance | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath
    [Runtime.InteropServices.NativeLibrary]::Free($nativeHandle)
}
