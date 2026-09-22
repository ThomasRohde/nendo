param(
    [Parameter(Mandatory)][string] $EngineDirectory,
    [Parameter(Mandatory)][string] $FilePath,
    [Parameter(Mandatory)][string] $ProposalId,
    [Parameter(Mandatory)][ValidateSet('Commit', 'Read')][string] $Mode
)
$ErrorActionPreference = 'Stop'
foreach ($assembly in @('SQLitePCLRaw.core.dll', 'SQLitePCLRaw.provider.e_sqlite3.dll',
        'SQLitePCLRaw.batteries_v2.dll', 'Microsoft.Data.Sqlite.dll', 'Nendo.Engine.dll',
        'MSTest.TestFramework.dll', 'Nendo.Engine.Tests.dll')) {
    [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath(
        [IO.Path]::GetFullPath((Join-Path $EngineDirectory $assembly)))
}
# ADR-0008. The Engine evaluates calculations through NCalc, so a fixture that holds
# them needs its closure beside the Engine. Loaded explicitly rather than through a
# Resolving handler: resolving from inside the default load context while it is
# already resolving is not legal, and fails as a file-load error rather than a
# missing file.
foreach ($assembly in @('ExtendedNumerics.BigDecimal.dll', 'Microsoft.Extensions.DependencyInjection.Abstractions.dll',
        'Microsoft.Extensions.Logging.Abstractions.dll', 'Parlot.dll', 'NCalc.Domain.dll', 'NCalc.Parser.dll',
        'NCalc.Core.dll', 'NCalc.dll')) {
    $expressionPath = [IO.Path]::GetFullPath((Join-Path $EngineDirectory $assembly))
    if (Test-Path -LiteralPath $expressionPath) {
        [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath($expressionPath)
    }
}
$nativeHandle = [System.Runtime.InteropServices.NativeLibrary]::Load(
    [IO.Path]::GetFullPath((Join-Path $EngineDirectory 'runtimes/win-x64/native/e_sqlite3.dll')))
try {
    [void][Nendo.Engine.Tests.ReviewOutcomeChildDriver]::RunAsync($FilePath, $ProposalId, $Mode).GetAwaiter().GetResult()
}
finally { [System.Runtime.InteropServices.NativeLibrary]::Free($nativeHandle) }
