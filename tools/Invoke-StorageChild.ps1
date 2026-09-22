[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $EngineDirectory,
    [Parameter(Mandatory)][string] $FilePath,
    [ValidateSet('OwnInstance', 'Restore', 'Upgrade', 'InspectRecovery', 'ResolveRecovery')][string] $Mode = 'OwnInstance',
    [string] $BackupPath,
    [string] $Checkpoint,
    [ValidateSet('KeepActive', 'UseRetainedOriginal', 'UseStagedReplacement')][string] $ResolutionChoice = 'KeepActive'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Test-only child process: open one existing disposable fixture, signal readiness,
# then wait for a normal close or parent-owned process termination. Restore
# fault seams live in the test assembly, never a production bridge or MCP API.
# No UI/input automation, shell interpolation or production discovery API.
foreach ($assembly in @('SQLitePCLRaw.core.dll', 'SQLitePCLRaw.provider.e_sqlite3.dll',
        'SQLitePCLRaw.batteries_v2.dll', 'Microsoft.Data.Sqlite.dll', 'Nendo.Engine.dll')) {
    $assemblyPath = [IO.Path]::GetFullPath((Join-Path $EngineDirectory $assembly))
    [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath($assemblyPath)
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
$nativePath = [IO.Path]::GetFullPath((Join-Path $EngineDirectory 'runtimes/win-x64/native/e_sqlite3.dll'))
$nativeHandle = [System.Runtime.InteropServices.NativeLibrary]::Load($nativePath)
$ownedSession = $null
try {
    if ($Mode -eq 'InspectRecovery') {
        $recovery = [Nendo.Engine.NendoWriteCoordinator]::InspectReplacementRecoveryAsync(
            $FilePath, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        [Console]::WriteLine(($recovery | ConvertTo-Json -Depth 12 -Compress))
        return
    }
    if ($Mode -eq 'ResolveRecovery') {
        if ([string]::IsNullOrWhiteSpace($Checkpoint)) {
            $review = [Nendo.Engine.NendoWriteCoordinator]::PrepareReplacementResolutionAsync(
                $FilePath, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            $result = [Nendo.Engine.NendoWriteCoordinator]::ResolveReplacementAsync(
                $review, [Nendo.Engine.NendoReplacementResolutionChoice]$ResolutionChoice,
                [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            [Console]::WriteLine([Text.Json.JsonSerializer]::Serialize(
                $result, $result.GetType(), [Text.Json.JsonSerializerOptions]$null))
        } else {
            foreach ($testAssembly in @('MSTest.TestFramework.dll', 'Nendo.Engine.Tests.dll')) {
                [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath(
                    [IO.Path]::GetFullPath((Join-Path $EngineDirectory $testAssembly)))
            }
            [Nendo.Engine.Tests.ResolutionChildDriver]::RunAsync($FilePath, $ResolutionChoice, $Checkpoint).GetAwaiter().GetResult()
        }
        return
    }
    if ($Mode -in @('Restore', 'Upgrade')) {
        if (($Mode -eq 'Restore' -and [string]::IsNullOrWhiteSpace($BackupPath)) -or [string]::IsNullOrWhiteSpace($Checkpoint)) {
            throw 'Replacement requires its disposable inputs and named checkpoint.'
        }
        foreach ($testAssembly in @('MSTest.TestFramework.dll', 'Nendo.Engine.Tests.dll')) {
            [void][System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath(
                [IO.Path]::GetFullPath((Join-Path $EngineDirectory $testAssembly)))
        }
        if ($Mode -eq 'Upgrade') {
            [Nendo.Engine.Tests.UpgradeChildDriver]::RunAsync($FilePath, $Checkpoint).GetAwaiter().GetResult()
        } else {
            [Nendo.Engine.Tests.RestoreChildDriver]::RunAsync($FilePath, $BackupPath, $Checkpoint).GetAwaiter().GetResult()
        }
        return
    }
    $ownedSession = [Nendo.Engine.NendoWriteCoordinator]::OpenAsync(
        $FilePath, "p4-child-$PID", [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    [Console]::WriteLine('OWNED')
    [Console]::Out.Flush()
    [void][Console]::ReadLine()
}
finally {
    if ($null -ne $ownedSession) { $ownedSession.DisposeAsync().GetAwaiter().GetResult() }
    [System.Runtime.InteropServices.NativeLibrary]::Free($nativeHandle)
}
