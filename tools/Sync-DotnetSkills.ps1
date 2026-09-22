[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
    [Parameter(ParameterSetName = 'Update', Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string] $UpdateToCommit,

    [Parameter(ParameterSetName = 'Check')]
    [switch] $Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lockPath = Join-Path $repoRoot '.agents/skills/dotnet-skills.lock.json'

if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    throw "Lock manifest not found: $lockPath"
}

$manifest = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json

function Get-ManifestFiles {
    param([Parameter(Mandatory = $true)] $Manifest)

    $entries = [Collections.Generic.List[object]]::new()

    foreach ($skill in @($Manifest.skills)) {
        foreach ($file in @($skill.files)) {
            $entries.Add([pscustomobject]@{
                Name   = $skill.name
                Kind   = 'skill'
                Record = $file
            })
        }
    }

    foreach ($file in @($Manifest.supportFiles)) {
        $entries.Add([pscustomobject]@{
            Name   = $file.name
            Kind   = 'support'
            Record = $file
        })
    }

    return $entries
}

function Resolve-RepositoryPath {
    param([Parameter(Mandatory = $true)][string] $RelativePath)

    if ([IO.Path]::IsPathRooted($RelativePath)) {
        throw "Manifest path must be relative: $RelativePath"
    }

    $fullPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $RelativePath))
    $rootPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

    if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest path escapes the repository: $RelativePath"
    }

    return $fullPath
}

function Get-GitBlobSha {
    param([Parameter(Mandatory = $true)][byte[]] $Bytes)

    $header = [Text.Encoding]::UTF8.GetBytes("blob $($Bytes.Length)`0")
    $payload = [byte[]]::new($header.Length + $Bytes.Length)
    [Array]::Copy($header, 0, $payload, 0, $header.Length)
    [Array]::Copy($Bytes, 0, $payload, $header.Length, $Bytes.Length)

    $sha1 = [Security.Cryptography.SHA1]::Create()
    try {
        return -join ($sha1.ComputeHash($payload) | ForEach-Object { $_.ToString('x2') })
    }
    finally {
        $sha1.Dispose()
    }
}

function Assert-SkillFrontMatter {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Text
    )

    if ($Path -notmatch '(?i)(^|/)SKILL\.md$') {
        return
    }

    if ($Text -notmatch '(?s)^---\r?\n.*?\r?\n---\r?\n') {
        throw "Skill front matter is missing or malformed: $Path"
    }

    if ($Text -notmatch '(?m)^name:\s*\S+') {
        throw "Skill name is missing: $Path"
    }

    if ($Text -notmatch '(?m)^description:\s*(>|>-|"|\S)') {
        throw "Skill description is missing: $Path"
    }
}

function Test-VendoredFiles {
    param([Parameter(Mandatory = $true)] $Manifest)

    $failures = [Collections.Generic.List[string]]::new()

    foreach ($entry in Get-ManifestFiles -Manifest $Manifest) {
        $relativePath = [string] $entry.Record.localPath
        $expected = ([string] $entry.Record.sourceBlobSha).ToLowerInvariant()
        $fullPath = Resolve-RepositoryPath -RelativePath $relativePath

        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            $failures.Add("MISSING  $relativePath")
            continue
        }

        $actual = Get-GitBlobSha -Bytes ([IO.File]::ReadAllBytes($fullPath))
        if ($actual -ne $expected) {
            $failures.Add("DRIFT    $relativePath (expected $expected, got $actual)")
            continue
        }

        Write-Host "OK       $relativePath"
    }

    if ($failures.Count -gt 0) {
        foreach ($failure in $failures) {
            Write-Error $failure
        }
        throw "Vendored .NET skill verification failed for $($failures.Count) file(s)."
    }

    Write-Host "Verified $((Get-ManifestFiles -Manifest $Manifest).Count) vendored file(s) from dotnet/skills@$($Manifest.source.commit)."
}

if ($PSCmdlet.ParameterSetName -eq 'Check') {
    Test-VendoredFiles -Manifest $manifest
    return
}

$commit = $UpdateToCommit.ToLowerInvariant()
$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) "nendo-dotnet-skills-$([guid]::NewGuid().ToString('N'))"
$entries = @(Get-ManifestFiles -Manifest $manifest)

try {
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

    foreach ($entry in $entries) {
        $sourcePath = ([string] $entry.Record.sourcePath).Replace('\', '/')
        $relativePath = [string] $entry.Record.localPath
        $stagedPath = Join-Path $stagingRoot $relativePath
        $stagedDirectory = Split-Path -Parent $stagedPath
        New-Item -ItemType Directory -Path $stagedDirectory -Force | Out-Null

        $uri = "https://raw.githubusercontent.com/dotnet/skills/$commit/$sourcePath"
        Write-Host "GET      $sourcePath"
        Invoke-WebRequest -Uri $uri -OutFile $stagedPath

        $bytes = [IO.File]::ReadAllBytes($stagedPath)
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        Assert-SkillFrontMatter -Path $relativePath.Replace('\', '/') -Text $text
        $entry.Record.sourceBlobSha = Get-GitBlobSha -Bytes $bytes
    }

    foreach ($entry in $entries) {
        $relativePath = [string] $entry.Record.localPath
        $source = Join-Path $stagingRoot $relativePath
        $destination = Resolve-RepositoryPath -RelativePath $relativePath
        $destinationDirectory = Split-Path -Parent $destination
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        [IO.File]::WriteAllBytes($destination, [IO.File]::ReadAllBytes($source))
        Write-Host "UPDATED  $relativePath"
    }

    $manifest.source.commit = $commit
    $manifest.source.retrievedOn = (Get-Date).ToString('yyyy-MM-dd')
    $json = $manifest | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($lockPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

    Test-VendoredFiles -Manifest $manifest
    Write-Host 'Review the Git diff before committing. The selection was not changed automatically.'
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
