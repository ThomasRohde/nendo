# Seeds the disposable `.nendo` file the real-host behaviour journey drives.
#
# A definition arrives by canonical operation, and no shell route authors one yet,
# so the file is built here through the Engine. What the journey then proves is what
# the shell does with a file that already carries calculations and one automatic
# action: shows the results, asks this device for consent, and keeps Studio reachable
# when a calculation cannot be done.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Path,
    [string] $EngineAssembly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts')) + [IO.Path]::DirectorySeparatorChar
$target = [IO.Path]::GetFullPath($Path)
if (-not $target.StartsWith($artifactsRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Seed into an owned artifact directory.' }
if (Test-Path -LiteralPath $target) { throw 'The fixture already exists; keep it or choose a new evidence directory.' }
[void] (New-Item -ItemType Directory -Path (Split-Path $target) -Force)

$engineDirectory = Join-Path $repoRoot 'artifacts/bin/Nendo.Engine.Tests/debug'
$enginePath = if ($EngineAssembly) { (Resolve-Path -LiteralPath $EngineAssembly).Path } else { Join-Path $engineDirectory 'Nendo.Engine.dll' }
if (-not (Test-Path -LiteralPath $enginePath)) { throw "Build the Engine tests first: no assembly at $enginePath." }
foreach ($assembly in @('SQLitePCLRaw.core.dll', 'SQLitePCLRaw.provider.e_sqlite3.dll',
        'SQLitePCLRaw.batteries_v2.dll', 'Microsoft.Data.Sqlite.dll', 'Nendo.Engine.dll',
        'MSTest.TestFramework.dll', 'Nendo.Engine.Tests.dll')) {
    $assemblyPath = if ($assembly -eq 'Nendo.Engine.dll') { $enginePath } else { Join-Path $engineDirectory $assembly }
    [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath($assemblyPath)
}
# ADR-0008. The fixture holds calculations, so the evaluator's closure has to be
# beside the Engine. Loaded explicitly rather than through a Resolving handler:
# resolving from inside the default load context while it is already resolving is
# not legal, and fails as a file-load error rather than a missing file.
foreach ($assembly in @('ExtendedNumerics.BigDecimal.dll', 'Microsoft.Extensions.DependencyInjection.Abstractions.dll',
        'Microsoft.Extensions.Logging.Abstractions.dll', 'Parlot.dll', 'NCalc.Domain.dll', 'NCalc.Parser.dll',
        'NCalc.Core.dll', 'NCalc.dll')) {
    $expressionPath = [IO.Path]::GetFullPath((Join-Path $engineDirectory $assembly))
    if (Test-Path -LiteralPath $expressionPath) {
        [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath($expressionPath)
    }
}
[void][Runtime.InteropServices.NativeLibrary]::Load((Join-Path $engineDirectory 'runtimes/win-x64/native/e_sqlite3.dll'))

[void] [Nendo.Engine.Tests.RuntimeBehaviourFixture]::CreateAsync($target).GetAwaiter().GetResult()
$inspection = [Nendo.Engine.Tests.RuntimeBehaviourFixture]::InspectAsync($target).GetAwaiter().GetResult()
Set-Content -LiteralPath ($target + '.json') -Value $inspection
Write-Output "Behaviour fixture seeded: $target"
