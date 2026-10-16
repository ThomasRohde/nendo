# Builds the pictures reference file, workspace/Herbarium.nendo (W-274, ADR-0031), through the
# Engine's typed operations, and the folder of linked pictures beside it. Refuses to write over a
# file that exists: move the old one away first. -Measure instead measures a file at the 2 GiB
# budget (open, backup, size) under artifacts/herbarium/measure; build nothing while it runs.
[CmdletBinding()]
param(
    [string] $Path = '',
    [switch] $Measure
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tool = Join-Path $PSScriptRoot 'herbarium/Herbarium.cs'
Push-Location (Split-Path $tool)
try {
    if ($Measure) {
        dotnet run $tool -- measure (Join-Path $repoRoot 'artifacts/herbarium/measure')
    }
    else {
        $target = if ($Path -ne '') { [IO.Path]::GetFullPath($Path) } else { Join-Path $repoRoot 'workspace/Herbarium.nendo' }
        dotnet run $tool -- build $target
    }
    if ($LASTEXITCODE -ne 0) { throw "The herbarium tool failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }
