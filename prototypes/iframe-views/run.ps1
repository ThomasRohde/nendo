#Requires -Version 7
<#
.SYNOPSIS
  Builds and runs the iframe-views spike: the main phase, then a restart of the harness on the
  same profile that reads the S16 storage back. Everything it writes lands in
  artifacts/spike-iframe-views (git-ignored).
.PARAMETER SitePerProcess
  Adds --site-per-process to the browser arguments. Uses its own profile and writes *-spp files.
.PARAMETER Only
  Comma-separated step ids, for example S1,S14. The restart phase runs only when S16 is included.
#>
param([switch]$SitePerProcess, [string]$Only = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$out = Join-Path $root 'artifacts/spike-iframe-views'
$build = Join-Path $out 'build'
$project = Join-Path $PSScriptRoot 'IframeViewsSpike.csproj'

# The local NuGet.Config has no sources: the pinned SDK must already be in the package cache.
dotnet restore $project --configfile (Join-Path $PSScriptRoot 'NuGet.Config') "-p:ArtifactsPath=$build"
if ($LASTEXITCODE) { throw "restore failed ($LASTEXITCODE)" }
dotnet build $project --no-restore -c Release "-p:ArtifactsPath=$build" -v minimal
if ($LASTEXITCODE) { throw "build failed ($LASTEXITCODE)" }

$exe = Join-Path $build 'bin/IframeViewsSpike/release/IframeViewsSpike.exe'
$common = @('--out', $out)
if ($SitePerProcess) { $common += '--site-per-process' }
if ($Only) { $common += @('--only', $Only) }

& $exe --phase main @common
if ($LASTEXITCODE) { throw "main phase exited $LASTEXITCODE" }
if (-not $Only -or ($Only -split ',') -contains 'S16') {
  & $exe --phase persist-read @common
  if ($LASTEXITCODE) { throw "persist-read phase exited $LASTEXITCODE" }
}

Get-ChildItem $out -Filter 'results-*.json' | Select-Object Name, Length, LastWriteTime
