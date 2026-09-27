[CmdletBinding()]
param(
    # A new, task-owned directory under artifacts/; the run writes its .nendo fixture and report there.
    [Parameter(Mandatory)][string] $OutputRoot
)
# ADR-0019 delivery stage 1: what a declared hierarchy costs at 10,000 records and depth 32,
# measured before any product code. Loads the debug test assembly (build it first:
# dotnet build tests/Nendo.Engine.Tests) and runs ReviewHierarchyCostFixture, as
# Review-Performance.ps1 runs its fixture.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts')) + [IO.Path]::DirectorySeparatorChar
$evidenceRoot = [IO.Path]::GetFullPath($OutputRoot)
if (-not $evidenceRoot.StartsWith($artifactsRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Use an owned artifact directory.' }
[void] (New-Item -ItemType Directory -Path $evidenceRoot -Force)
$engineDirectory = Join-Path $repoRoot 'artifacts/bin/Nendo.Engine.Tests/debug'
$filePath = Join-Path $evidenceRoot 'hierarchy-10000.nendo'
$reportPath = Join-Path $evidenceRoot 'hierarchy-cost.json'
if (Test-Path -LiteralPath $reportPath) { throw 'This run already has a report; choose a new output directory.' }
foreach ($assembly in @('SQLitePCLRaw.core.dll', 'SQLitePCLRaw.provider.e_sqlite3.dll',
        'SQLitePCLRaw.batteries_v2.dll', 'Microsoft.Data.Sqlite.dll', 'Nendo.Engine.dll',
        'MSTest.TestFramework.dll', 'Nendo.Engine.Tests.dll')) {
    [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath((Join-Path $engineDirectory $assembly))
}
foreach ($assembly in @('ExtendedNumerics.BigDecimal.dll', 'Microsoft.Extensions.DependencyInjection.Abstractions.dll',
        'Microsoft.Extensions.Logging.Abstractions.dll', 'Parlot.dll', 'NCalc.Domain.dll', 'NCalc.Parser.dll',
        'NCalc.Core.dll', 'NCalc.dll')) {
    $expressionPath = Join-Path $engineDirectory $assembly
    if (Test-Path -LiteralPath $expressionPath) { [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath($expressionPath) }
}
$nativeHandle = [Runtime.InteropServices.NativeLibrary]::Load((Join-Path $engineDirectory 'runtimes/win-x64/native/e_sqlite3.dll'))
$report = [ordered]@{
    startedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    decision = 'docs/decisions/0019-hierarchies-in-the-schema.md'
    decisionSha256 = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'docs/decisions/0019-hierarchies-in-the-schema.md') -Algorithm SHA256).Hash.ToLowerInvariant()
    driverSha256 = (Get-FileHash -LiteralPath (Join-Path $engineDirectory 'Nendo.Engine.Tests.dll') -Algorithm SHA256).Hash.ToLowerInvariant()
    status = 'not-completed'
}
try {
    $result = [Nendo.Engine.Tests.ReviewHierarchyCostFixture]::RunAsync($filePath).GetAwaiter().GetResult()
    $report.status = 'completed'
    $report.result = $result | ConvertFrom-Json
    Write-Host $result
}
catch {
    $report.status = 'failed'
    $report.error = $_.Exception.ToString()
    throw
}
finally {
    $report.finishedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath
    [Runtime.InteropServices.NativeLibrary]::Free($nativeHandle)
}
