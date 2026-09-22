[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $repoRoot 'src'
$allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@(
    'src/Nendo.Engine/IdeaGardenCompatibility.cs',
    'src/Nendo.Engine/IdeaGardenDefinition.cs',
    'src/Nendo.Desktop/IdeaGardenDesktopCompatibility.cs',
    'src/Nendo.Desktop/IdeaGardenProtocolCompatibility.cs',
    'src/Nendo.Workbench/src/application-recipes.ts',
    'src/Nendo.Workbench/src/idea-garden-recipe.ts',
    'src/Nendo.Workbench/src/preview-fixtures.ts'
) | ForEach-Object { [void] $allowed.Add($_) }

$applicationVocabulary = '(?i)\b[A-Za-z0-9_]*(?:idea|decision)[A-Za-z0-9_]*\b'
$sourceFiles = @(
    Get-ChildItem -LiteralPath $sourceRoot -Recurse -File |
        Where-Object {
            $_.Extension -in @('.cs', '.ts', '.css', '.xaml', '.json') -and
            $_.FullName -notmatch '[\\/](?:node_modules|bin|obj|dist)[\\/]'
        }
)

$violations = [Collections.Generic.List[string]]::new()
$vocabularyLocations = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $sourceFiles) {
    $relative = [IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
    $text = [IO.File]::ReadAllText($file.FullName)
    if ($text -notmatch $applicationVocabulary) {
        continue
    }
    [void] $vocabularyLocations.Add($relative)
    if (-not $allowed.Contains($relative)) {
        $violations.Add($relative)
    }
}

if ($violations.Count -gt 0) {
    throw "Application-specific vocabulary escaped its named recipe, fixture or compatibility edge:`n$($violations -join "`n")"
}

$missingAllowlistEntries = @($allowed | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Leaf) })
if ($missingAllowlistEntries.Count -gt 0) {
    throw "Application-neutrality allowlist contains missing files:`n$($missingAllowlistEntries -join "`n")"
}

$genericProtocol = [IO.File]::ReadAllText((Join-Path $repoRoot 'src/Nendo.Desktop/WorkbenchProtocol.cs'))
foreach ($method in @('proposal.prepareChangeSet', 'data.createRecord', 'data.setField', 'data.executeCommand')) {
    if ($genericProtocol.IndexOf($method, [StringComparison]::Ordinal) -lt 0) {
        throw "Current Workbench protocol is missing generic method $method."
    }
}

$browserHost = [IO.File]::ReadAllText((Join-Path $repoRoot 'src/Nendo.Workbench/src/host.ts'))
if ($browserHost -notmatch '(?m)^export const protocolVersion = 7;$') {
    throw 'Production Workbench is not pinned to generic protocol version 7.'
}

$clientVocabulary = '(?i)\b(?:codex|claude)\b'
$clientViolations = [Collections.Generic.List[string]]::new()
foreach ($file in $sourceFiles) {
    # Qualified-client setup instructions are content, not client-specific server behavior.
    $relative = [IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
    if ($relative -eq 'src/Nendo.Workbench/src/client-help.ts') { continue }
    $text = [IO.File]::ReadAllText($file.FullName)
    if ($text -match $clientVocabulary) {
        $clientViolations.Add([IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/'))
    }
}
if ($clientViolations.Count -gt 0) {
    throw "Client-specific vocabulary escaped test/evidence code:`n$($clientViolations -join "`n")"
}

Write-Host "OK       application-neutral shared boundary ($($sourceFiles.Count) source files scanned)"
Write-Host 'OK       client-neutral production source boundary'
Write-Host 'Allowlisted application vocabulary:'
foreach ($path in @($vocabularyLocations | Sort-Object)) {
    Write-Host "         $path"
}
